/**
 * The R2 pool's allocation and failover contract.
 *
 * What is pinned here is the stuff that is invisible until it costs money or
 * data: that capacity is never oversubscribed, that a dead bucket does not fail
 * a user's upload, that a reservation is always handed back, and that a wrong
 * STORAGE_ENC_KEY does not cascade into "every account is broken".
 */

const mongoose = require('mongoose');
const R2Account = require('../models/R2Account.model');
const storageService = require('../services/storage.service');

const GB = 1024 * 1024 * 1024;
const id = () => new mongoose.Types.ObjectId();

const account = (over = {}) => ({
  _id: id(),
  name: 'acc',
  capacityBytes: 10 * GB,
  usedBytes: 0,
  reservedBytes: 0,
  priority: 0,
  ...over,
});

afterEach(() => {
  jest.restoreAllMocks();
  storageService._clients.clear();
});

describe('the model answers capacity questions honestly', () => {
  it('canFit refuses when used + reserved + incoming exceeds capacity', () => {
    const doc = new R2Account({
      name: 'a', accountId: 'x', bucket: 'b', endpoint: 'https://e',
      accessKeyId: 'k', secretAccessKeyEnc: 'v1:a:b:c', publicBaseUrl: 'https://pub',
      capacityBytes: 1000, usedBytes: 600, reservedBytes: 300,
    });

    expect(doc.canFit(100)).toBe(true);
    expect(doc.canFit(101)).toBe(false);
    expect(doc.availableBytes).toBe(100);
  });

  it('counts a reservation as spent, not free', () => {
    const doc = new R2Account({
      name: 'a', accountId: 'x', bucket: 'b', endpoint: 'https://e',
      accessKeyId: 'k', secretAccessKeyEnc: 'v1:a:b:c', publicBaseUrl: 'https://pub',
      capacityBytes: 1000, usedBytes: 0, reservedBytes: 900,
    });
    expect(doc.usedRatio).toBeCloseTo(0.9);
    expect(doc.canFit(200)).toBe(false);
  });

  it('a non-active account fits nothing, however empty', () => {
    const base = {
      name: 'a', accountId: 'x', bucket: 'b', endpoint: 'https://e',
      accessKeyId: 'k', secretAccessKeyEnc: 'v1:a:b:c', publicBaseUrl: 'https://pub',
      capacityBytes: 1000,
    };
    expect(new R2Account({ ...base, status: 'draining' }).canFit(1)).toBe(false);
    expect(new R2Account({ ...base, isActive: false }).canFit(1)).toBe(false);
  });

  it('never exposes the secret through toAdminJSON', () => {
    const doc = new R2Account({
      name: 'a', accountId: 'x', bucket: 'b', endpoint: 'https://e',
      accessKeyId: 'k', secretAccessKeyEnc: 'v1:iv:tag:ciphertext', publicBaseUrl: 'https://pub',
    });
    const json = JSON.stringify(doc.toAdminJSON());
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('secretAccessKeyEnc');
  });
});

describe('least_used ordering', () => {
  it('puts the emptiest bucket first, by ratio and not by absolute bytes', () => {
    // b is larger in absolute used bytes but far emptier proportionally.
    const a = account({ capacityBytes: 10 * GB, usedBytes: 9 * GB });
    const b = account({ capacityBytes: 100 * GB, usedBytes: 20 * GB });

    const [first] = storageService._orderByUsedRatio([a, b]);
    expect(String(first._id)).toBe(String(b._id));
  });

  it('behaves as plain round-robin when every account is the same size', () => {
    const a = account({ usedBytes: 2 * GB });
    const b = account({ usedBytes: 1 * GB });
    const c = account({ usedBytes: 3 * GB });

    const order = storageService._orderByUsedRatio([a, b, c]).map((x) => x.usedBytes);
    expect(order).toEqual([1 * GB, 2 * GB, 3 * GB]);
  });

  it('breaks ties on priority, then deterministically', () => {
    const a = account({ priority: 5 });
    const b = account({ priority: 1 });
    const [first] = storageService._orderByUsedRatio([a, b]);
    expect(String(first._id)).toBe(String(b._id));
  });
});

describe('reserve', () => {
  const mockCandidates = (list) => {
    jest.spyOn(R2Account, 'find').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(list) }),
    });
  };

  it('refuses with 507 when no account has room — never picks one anyway', async () => {
    jest.spyOn(storageService, 'getStrategy').mockResolvedValue('least_used');
    mockCandidates([account({ capacityBytes: 100, usedBytes: 100 })]);
    const update = jest.spyOn(R2Account, 'findOneAndUpdate');

    await expect(storageService.reserve(50)).rejects.toMatchObject({ statusCode: 507 });
    expect(update).not.toHaveBeenCalled();
  });

  it('skips accounts already tried in this request', async () => {
    jest.spyOn(storageService, 'getStrategy').mockResolvedValue('least_used');
    const finder = jest.spyOn(R2Account, 'find').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([]) }),
    });

    await expect(storageService.reserve(10, ['abc'])).rejects.toMatchObject({ statusCode: 507 });
    expect(finder).toHaveBeenCalledWith(expect.objectContaining({
      _id: { $nin: ['abc'] },
    }));
  });

  it('re-checks capacity inside the update, so a lost race cannot oversubscribe', async () => {
    jest.spyOn(storageService, 'getStrategy').mockResolvedValue('least_used');
    const a = account();
    mockCandidates([a]);

    jest.spyOn(R2Account, 'findOneAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ ...a, secretAccessKeyEnc: 'x' }),
    });

    await storageService.reserve(1024);

    const [filter, update] = R2Account.findOneAndUpdate.mock.calls[0];
    expect(filter.$expr).toEqual({
      $lte: [{ $add: ['$usedBytes', '$reservedBytes', 1024] }, '$capacityBytes'],
    });
    expect(update.$inc).toEqual({ reservedBytes: 1024 });
  });

  it('moves to the next candidate when the atomic update matches nothing', async () => {
    jest.spyOn(storageService, 'getStrategy').mockResolvedValue('least_used');
    const a = account({ usedBytes: 1 });
    const b = account({ usedBytes: 2 });
    mockCandidates([a, b]);

    jest.spyOn(R2Account, 'findOneAndUpdate')
      .mockReturnValueOnce({ select: () => Promise.resolve(null) })          // lost the race
      .mockReturnValueOnce({ select: () => Promise.resolve({ ...b, secretAccessKeyEnc: 'x' }) });

    const won = await storageService.reserve(10);
    expect(String(won._id)).toBe(String(b._id));
    expect(R2Account.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('rejects a nonsensical size rather than reserving zero bytes', async () => {
    await expect(storageService.reserve(0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(storageService.reserve(-5)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('upload — failover and reservation hygiene', () => {
  const KEY = 'a'.repeat(64);

  const setup = () => {
    process.env.STORAGE_ENC_KEY = KEY;
    jest.spyOn(storageService, 'commit').mockResolvedValue();
    jest.spyOn(storageService, 'release').mockResolvedValue();
    jest.spyOn(storageService, 'markError').mockResolvedValue();
  };

  afterEach(() => { delete process.env.STORAGE_ENC_KEY; });

  it('falls over to a second account and still succeeds', async () => {
    setup();
    const bad = account({ name: 'bad', bucket: 'b1', publicBaseUrl: 'https://pub1.r2.dev' });
    const good = account({ name: 'good', bucket: 'b2', publicBaseUrl: 'https://pub2.r2.dev' });

    jest.spyOn(storageService, 'reserve')
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(good);

    const send = jest.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({});
    jest.spyOn(storageService, '_clientFor').mockReturnValue({ send });

    const result = await storageService.upload({
      key: 'shop1/media1.webp',
      body: Buffer.from('imagedata'),
      contentType: 'image/webp',
    });

    expect(result.url).toBe('https://pub2.r2.dev/shop1/media1.webp');
    expect(storageService.markError).toHaveBeenCalledWith(bad._id, 'connection reset');
    // the failed attempt's reservation was handed back
    expect(storageService.release).toHaveBeenCalledWith(bad._id, 9);
    // The options arg arrived when `upload` became a one-object `uploadGroup`:
    // ops are counted per PUT, not per call, because a media upload is three.
    expect(storageService.commit).toHaveBeenCalledWith(good._id, 9, { files: 1, classAOps: 1 });
  });

  it('releases the reservation on every failed attempt, then reports 502', async () => {
    setup();
    const accounts = [account(), account(), account()];
    jest.spyOn(storageService, 'reserve')
      .mockResolvedValueOnce(accounts[0])
      .mockResolvedValueOnce(accounts[1])
      .mockResolvedValueOnce(accounts[2]);
    jest.spyOn(storageService, '_clientFor').mockReturnValue({
      send: jest.fn().mockRejectedValue(new Error('503 from R2')),
    });

    await expect(storageService.upload({
      key: 'k', body: Buffer.from('xy'), contentType: 'image/webp',
    })).rejects.toMatchObject({ statusCode: 502 });

    expect(storageService.release).toHaveBeenCalledTimes(3);
    expect(storageService.commit).not.toHaveBeenCalled();
  });

  it('does NOT blame the accounts when our own encryption key is wrong', async () => {
    setup();
    const acc = account();
    jest.spyOn(storageService, 'reserve').mockResolvedValue(acc);
    jest.spyOn(storageService, '_clientFor').mockImplementation(() => {
      throw new Error('Failed to decrypt stored secret');
    });

    await expect(storageService.upload({
      key: 'k', body: Buffer.from('xy'),
    })).rejects.toThrow(/decrypt/);

    // the whole pool must not be marked broken because of a local config fault
    expect(storageService.markError).not.toHaveBeenCalled();
    expect(storageService.release).toHaveBeenCalledWith(acc._id, 2);
  });

  it('refuses to run at all without an encryption key', async () => {
    delete process.env.STORAGE_ENC_KEY;
    await expect(storageService.upload({
      key: 'k', body: Buffer.from('xy'),
    })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rejects an empty body instead of writing a zero-byte object', async () => {
    setup();
    await expect(storageService.upload({ key: 'k', body: Buffer.alloc(0) }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(storageService.upload({ key: '', body: Buffer.from('x') }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('sends an immutable long cache header — product images never change in place', async () => {
    setup();
    jest.spyOn(storageService, 'reserve').mockResolvedValue(account({ publicBaseUrl: 'https://p.r2.dev' }));
    const send = jest.fn().mockResolvedValue({});
    jest.spyOn(storageService, '_clientFor').mockReturnValue({ send });

    await storageService.upload({ key: 'k.webp', body: Buffer.from('x'), contentType: 'image/webp' });

    expect(send.mock.calls[0][0].input).toMatchObject({
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: 'image/webp',
    });
  });
});

describe('publicUrlFor', () => {
  it('joins base and key with exactly one slash', () => {
    expect(storageService.publicUrlFor({ publicBaseUrl: 'https://p.r2.dev' }, 'a/b.webp'))
      .toBe('https://p.r2.dev/a/b.webp');
    expect(storageService.publicUrlFor({ publicBaseUrl: 'https://p.r2.dev/' }, '/a/b.webp'))
      .toBe('https://p.r2.dev/a/b.webp');
  });

  it('returns empty rather than a broken url when either half is missing', () => {
    expect(storageService.publicUrlFor({}, 'a.webp')).toBe('');
    expect(storageService.publicUrlFor({ publicBaseUrl: 'https://p' }, '')).toBe('');
  });
});
