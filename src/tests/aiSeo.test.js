/**
 * The AI SEO writer — what it sends, and what it refuses to hand back.
 *
 * The model is mocked. What is under test is everything AROUND the call, which
 * is where every failure this feature can have actually lives:
 *
 *   REGRESSIONS — the response handling. A model that answers with a ```json
 *     fence, or with a 900-character description, or with nothing usable at
 *     all, must not put that on a shop's public page. Each of these fails if
 *     its guard is removed.
 *
 *   INVARIANT GUARD — the 422 contract. `withAiMessage` in the controller
 *     refunds every status EXCEPT 422, because a 422 means a real Gemini call
 *     was made and answered. If these throws stop being 422s, a loop of
 *     unusable requests costs the platform unbounded quota at no cost to the
 *     sender. Nothing has broken it; the status is the contract.
 *
 *   INVARIANT GUARD — the prompt must not promise anything. The output is
 *     published under the SHOP's name, to their customers. "সারা দেশে ফ্রি
 *     ডেলিভারি" invented by us is a commitment a shopkeeper never made and will
 *     be held to, and no amount of review catches it if nobody reads the copy.
 */

jest.mock('../services/gemini.service', () => ({ generateContent: jest.fn() }));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const gemini = require('../services/gemini.service');
const aiSeo = require('../services/aiSeo.service');

const SHOP = { _id: 'shop1', name: 'রহিম স্টোর', address: 'মিরপুর, ঢাকা' };

beforeEach(() => jest.clearAllMocks());

describe('generateShopSeo', () => {
  const answer = (obj) => gemini.generateContent.mockResolvedValue(JSON.stringify(obj));

  it('returns the model\'s title and description', async () => {
    answer({ title: 'রহিম স্টোর — মুদি ও নিত্যপ্রয়োজনীয়', description: 'মিরপুরের মুদি দোকান।' });
    const out = await aiSeo.generateShopSeo(SHOP, { categories: ['চাল'], products: ['মিনিকেট চাল'] });
    expect(out).toMatchObject({
      title: 'রহিম স্টোর — মুদি ও নিত্যপ্রয়োজনীয়',
      description: 'মিরপুরের মুদি দোকান।',
    });
  });

  it('survives a model that fences its JSON', async () => {
    // `responseMimeType: application/json` makes this rare, not impossible, and
    // the cost of being wrong is a 422 on a message the shop already paid for.
    gemini.generateContent.mockResolvedValue(
      '```json\n{"title":"রহিম স্টোর","description":"মুদি দোকান।"}\n```'
    );
    await expect(aiSeo.generateShopSeo(SHOP, {})).resolves.toMatchObject({ title: 'রহিম স্টোর' });
  });

  it('flattens a newline the model put in a meta description', async () => {
    answer({ title: 'রহিম\nস্টোর', description: 'চাল,\nডাল' });
    const out = await aiSeo.generateShopSeo(SHOP, {});
    expect(out.title).toBe('রহিম স্টোর');
    expect(out.description).toBe('চাল, ডাল');
  });

  it('clamps an over-long answer instead of spending the message on nothing', async () => {
    // A schema constrains shape, not length: `{type: string}` is satisfied by
    // 900 characters. Rejecting would burn the shop's message for a result that
    // only needed trimming.
    answer({ title: 'ক'.repeat(400), description: 'খ'.repeat(900) });
    const out = await aiSeo.generateShopSeo(SHOP, {});
    expect(out.title.length).toBeLessThanOrEqual(120);
    expect(out.description.length).toBeLessThanOrEqual(320);
  });

  it('throws 422 — not 500 — when the answer is unusable', async () => {
    // 422 is the one status the controller does NOT refund. See the header.
    gemini.generateContent.mockResolvedValue('sorry, I cannot help with that');
    await expect(aiSeo.generateShopSeo(SHOP, {})).rejects.toMatchObject({ statusCode: 422 });

    answer({ title: '', description: '' });
    await expect(aiSeo.generateShopSeo(SHOP, {})).rejects.toMatchObject({ statusCode: 422 });
  });

  it('puts the shop\'s own catalogue in the prompt, and forbids invented claims', async () => {
    answer({ title: 'ক', description: 'খ' });
    await aiSeo.generateShopSeo(SHOP, {
      categories: ['চাল', 'ডাল'],
      products: ['মিনিকেট চাল ৫ কেজি'],
    });

    const [prompt] = gemini.generateContent.mock.calls[0];
    // Without the catalogue the model writes a sentence that would fit any shop
    // on the platform — and a generic description is exactly what Google
    // discards in favour of its own snippet.
    expect(prompt).toContain('চাল');
    expect(prompt).toContain('মিনিকেট চাল ৫ কেজি');
    expect(prompt).toContain('রহিম স্টোর');
    // The promise guard. This is published under the shop's name.
    expect(prompt).toContain('ডেলিভারি চার্জ');
  });

  it('caps how much of the catalogue is sent', async () => {
    answer({ title: 'ক', description: 'খ' });
    await aiSeo.generateShopSeo(SHOP, {
      categories: Array.from({ length: 40 }, (_, i) => `ক্যাট${i}`),
      products: Array.from({ length: 80 }, (_, i) => `পণ্য${i}`),
    });
    const [prompt] = gemini.generateContent.mock.calls[0];
    // The signal saturates after about a dozen names; the rest is tokens paid
    // for on every request.
    expect(prompt).toContain('ক্যাট11');
    expect(prompt).not.toContain('ক্যাট12');
    expect(prompt).not.toContain('পণ্য12');
  });

  it('refuses a shop with no name before spending a Gemini call', async () => {
    await expect(aiSeo.generateShopSeo({ _id: 'x', name: '  ' }, {})).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(gemini.generateContent).not.toHaveBeenCalled();
  });
});

describe('generateProductDescription', () => {
  const product = {
    _id: 'p1',
    name: 'মিনিকেট চাল ৫ কেজি',
    brand: 'ফ্রেশ',
    unit: 'বস্তা',
    sellingPrice: 450,
    onlinePrice: 430,
    category: { name: 'চাল' },
  };

  it('returns a description built from the saved product', async () => {
    gemini.generateContent.mockResolvedValue(JSON.stringify({ description: 'ভালো মানের চাল।' }));
    await expect(aiSeo.generateProductDescription(SHOP, product)).resolves.toEqual({
      description: 'ভালো মানের চাল।',
    });

    const [prompt] = gemini.generateContent.mock.calls[0];
    expect(prompt).toContain('মিনিকেট চাল ৫ কেজি');
    expect(prompt).toContain('ফ্রেশ');
    // The ONLINE price, matching what the public page renders. Quoting the shelf
    // price would have the model reason about a figure no customer will see.
    expect(prompt).toContain('430');
    expect(prompt).not.toContain('450');
    // Told the price so it does not contradict the page, told not to repeat it
    // because the page already renders it — a price in prose goes stale the day
    // the shop changes it.
    expect(prompt).toContain('দামের অঙ্ক বর্ণনায় লিখবে না');
    // And told not to invent the attributes a customer would act on.
    expect(prompt).toContain('অনুমান করে লিখবে না');
  });

  it('falls back to the shelf price when no online price is set', async () => {
    gemini.generateContent.mockResolvedValue(JSON.stringify({ description: 'x' }));
    await aiSeo.generateProductDescription(SHOP, { ...product, onlinePrice: undefined });
    expect(gemini.generateContent.mock.calls[0][0]).toContain('450');
  });

  it('clamps a runaway description', async () => {
    gemini.generateContent.mockResolvedValue(JSON.stringify({ description: 'ক'.repeat(2000) }));
    const out = await aiSeo.generateProductDescription(SHOP, product);
    expect(out.description.length).toBeLessThanOrEqual(600);
  });

  it('throws 422 on an unusable answer', async () => {
    gemini.generateContent.mockResolvedValue('{}');
    await expect(aiSeo.generateProductDescription(SHOP, product)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('refuses a product with no name before spending a Gemini call', async () => {
    await expect(aiSeo.generateProductDescription(SHOP, { _id: 'p' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(gemini.generateContent).not.toHaveBeenCalled();
  });
});
