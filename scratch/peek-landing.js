require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const doc = await mongoose.connection.db
    .collection('landingpages')
    .findOne({ _id: new mongoose.Types.ObjectId('6a8053010901ea3b00822dec') },
      { projection: { html: 0, htmlHistory: 0, manifest: 0, content: 0 } });
  console.log(JSON.stringify(doc, null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
