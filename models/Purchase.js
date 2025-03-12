const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['ebook', 'coaching'],
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  downloadLink: {
    type: String,
    // Only for ebooks
  },
  packageHours: {
    type: String,
    // Only for coaching packages
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'eur'
  },
  sessionId: {
    type: String,
    required: true
  },
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'refunded'],
    default: 'completed'
  }
});

const Purchase = mongoose.model('Purchase', purchaseSchema);
module.exports = Purchase; 