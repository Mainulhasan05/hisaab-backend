require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const doc = await mongoose.connection.db
    .collection('landingpages')
    .findOne({ slug: 'matirsaad' }, { projection: { html: 1, title: 1 } });

  const html = doc?.html || '';
  fs.writeFileSync(`${__dirname}/matirsaad.html`, html);
  console.log('length:', html.length);
  console.log('has <style>:', /<style/i.test(html));
  console.log('style blocks:', (html.match(/<style/gi) || []).length);
  console.log('first 1200 chars:\n', html.slice(0, 1200));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
