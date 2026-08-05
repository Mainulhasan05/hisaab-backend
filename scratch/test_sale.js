require('dotenv').config();
const mongoose = require('mongoose');
const saleService = require('../src/services/sale.service');
const Sale = require('../src/models/Sale.model');

async function testSale() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('DB Connected');

    const saleId = '6a72e59b0d15a4db983bcd88';
    console.log(`Testing sale lookup for ID: ${saleId}...`);

    const saleDoc = await Sale.findById(saleId).lean();
    console.log('Raw Sale Doc:', saleDoc ? { _id: saleDoc._id, invoiceNo: saleDoc.invoiceNo, shop: saleDoc.shop } : 'Not found');

    if (saleDoc) {
      console.log('Attempting saleService.getSaleById(saleId, shopId)...');
      const fullSale = await saleService.getSaleById(saleId, saleDoc.shop);
      console.log('Full Sale Result:', fullSale ? fullSale.invoiceNo : 'null');
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('CRITICAL ERROR during sale lookup:', err);
  }
}

testSale();
