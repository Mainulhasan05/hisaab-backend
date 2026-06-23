const path = require('path');
require('dotenv').config();
const mongoose = require('mongoose');
const cacheService = require('../src/services/cache.service');

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');
  
  const User = require('../src/models/User.model');
  const Shop = require('../src/models/Shop.model');
  
  const phones = ['01757995016', '0175799501'];
  
  for (const phone of phones) {
    console.log(`\nChecking phone: ${phone}`);
    const user = await User.findOne({ phone }).populate('shop');
    if (!user) {
      console.log('User not found.');
      continue;
    }
    
    console.log('User found:');
    console.log(`- ID: ${user._id}`);
    console.log(`- Name: ${user.name}`);
    console.log(`- IsActive: ${user.isActive}`);
    console.log(`- IsPhoneVerified: ${user.isPhoneVerified}`);
    
    if (user.shop) {
      console.log('Shop details:');
      console.log(`- Shop ID: ${user.shop._id}`);
      console.log(`- Name: ${user.shop.name}`);
      console.log(`- IsActive: ${user.shop.isActive}`);
      console.log(`- Subscription Status: ${user.shop.subscription?.status}`);
      console.log(`- Subscription Expires: ${user.shop.subscription?.expiresAt}`);
      console.log(`- isSubscriptionValid (computed): ${user.shop.isSubscriptionValid}`);
    } else {
      console.log('No shop linked to this user.');
    }
    
    // Check cache
    const cacheKey = `auth:user:${user._id}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      console.log('Cached value exists:', JSON.stringify(cached, null, 2));
      await cacheService.delete(cacheKey);
      console.log(`Deleted cache for key: ${cacheKey}`);
    } else {
      console.log('No cached value found.');
    }
  }

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
