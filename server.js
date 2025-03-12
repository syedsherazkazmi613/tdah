require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');
const fs = require('fs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const connectDB = require('./config/database');
const User = require('./models/User');
const Purchase = require('./models/Purchase');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(express.static('views'));

// Connect to MongoDB
connectDB();

// Add session middleware after other middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGODB_URI,
    ttl: 14 * 24 * 60 * 60 // 14 days
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 14 * 24 * 60 * 60 * 1000 // 14 days
  }
}));

// Authentication middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  // Store the original URL they were trying to access
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'aboutus.html'));
});

app.get('/services', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'services.html'));
});

app.get('/ebooks', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'ebooks.html'));
});

app.get('/contact', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'contact.html'));
});

app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    console.log('No session ID provided, redirecting to ebooks');
    return res.redirect('/ebooks');
  }
  
  // Simply redirect to the static success.html page with the session ID
  res.redirect(`/success.html?session_id=${sessionId}`);
});

// Add this endpoint to provide download details via AJAX
app.get('/success-details', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'No session ID provided' });
  }
  
  try {
    // Verify the checkout session was successful
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    
    // Get the purchased item details
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
    const purchasedItem = lineItems.data[0];
    
    // Log the actual price ID for debugging
    console.log('Success page - Price ID:', purchasedItem.price.id);
    
    // Determine which PDF to provide based on the price ID
    let pdfInfo = {};
    
    // Use the actual price IDs from your Stripe dashboard
    const priceId = purchasedItem.price.id;
    
    if (priceId === 'price_1R0QfvApqHAPZGzE7PvD6lUN') {
      pdfInfo = {
        title: "ADHD: What If It Were a Superpower?",
        filename: "adhd_superpower.pdf",
        path: process.env.EBOOK1_PDF_PATH || './pdfs/adhd_superpower.pdf'
      };
    } 
    else if (priceId === 'price_YOUR_ACTUAL_SECOND_EBOOK_PRICE_ID') {
      pdfInfo = {
        title: "When You're a Parent and You've Had Enough",
        filename: "parent_guide.pdf",
        path: process.env.EBOOK2_PDF_PATH || './pdfs/parent_guide.pdf'
      };
    }
    else {
      console.error('Unknown price ID:', priceId);
      return res.status(400).json({ error: 'Unknown product' });
    }
    
    // Generate a simple download ID using the session ID
    const downloadId = Buffer.from(sessionId).toString('base64');
    
    // Store the session info in memory (or use a database for production)
    if (!global.downloadSessions) {
      global.downloadSessions = {};
    }
    
    global.downloadSessions[downloadId] = {
      pdfPath: pdfInfo.path,
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };
    
    // Return the download details
    res.json({
      title: pdfInfo.title,
      downloadId: downloadId,
      filename: pdfInfo.filename
    });
    
  } catch (error) {
    console.error('Error processing success details:', error);
    res.status(500).json({ error: 'Error processing your purchase' });
  }
});

// Add an endpoint to handle secure PDF downloads
app.get('/download/:downloadId', (req, res) => {
  const downloadId = req.params.downloadId;
  
  // Check if the download session exists and is valid
  if (!global.downloadSessions || 
      !global.downloadSessions[downloadId] ||
      global.downloadSessions[downloadId].expiresAt < Date.now()) {
    return res.status(403).send('Invalid or expired download link');
  }
  
  const pdfPath = global.downloadSessions[downloadId].pdfPath;
  
  // Check if the file exists
  if (!fs.existsSync(pdfPath)) {
    console.error('PDF file not found:', pdfPath);
    return res.status(404).send('PDF file not found');
  }
  
  // Send the PDF file
  res.download(pdfPath, path.basename(pdfPath), (err) => {
    if (err) {
      console.error('Error downloading file:', err);
      res.status(500).send('Error downloading file');
    }
  });
});

// Add this endpoint to provide the publishable key to the client
app.get('/stripe-config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// Add the checkout session endpoint with better error logging
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('Received checkout request with body:', req.body);
    
    const { priceId } = req.body;
    
    if (!priceId) {
      console.error('No price ID provided in request');
      return res.status(400).json({ error: 'Price ID is required' });
    }
    
    // Check if user is authenticated for purchases
    if (!req.session.userId) {
      return res.status(401).json({ 
        error: 'Authentication required',
        redirectUrl: '/login?redirect=' + encodeURIComponent('/ebooks')
      });
    }
    
    console.log(`Creating checkout session for price ID: ${priceId}`);
    
    // Verify the price exists in Stripe before creating a session
    try {
      const price = await stripe.prices.retrieve(priceId);
      console.log(`Price verified: ${price.id}`);
    } catch (priceError) {
      console.error(`Error retrieving price: ${priceError.message}`);
      return res.status(400).json({ error: `Invalid price ID: ${priceError.message}` });
    }
    
    const user = await User.findById(req.session.userId);
    const ebookTitle = "ADHD: What If It Were a Superpower?";
    const ebookPrice = priceId;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/ebooks`,
      customer_email: user.email,
      metadata: {
        userId: user._id.toString(),
        ebookTitle: ebookTitle,
        ebookPrice: ebookPrice
      }
    });
    
    console.log(`Checkout session created: ${session.id}`);
    res.json({ id: session.id });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login page - only accessible to guests
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Register page - only accessible to guests
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

// Login POST endpoint
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Set user session
    req.session.userId = user._id;
    req.session.userName = user.name;
    
    // Redirect to the page they were trying to access or home
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    
    res.json({ success: true, redirect: returnTo });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register POST endpoint
app.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    
    // Create new user
    const user = new User({ name, email, password });
    await user.save();
    
    // Set user session
    req.session.userId = user._id;
    req.session.userName = user.name;
    
    res.json({ success: true, redirect: '/' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout endpoint
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.redirect('/');
  });
});

// Profile page - only accessible to authenticated users
app.get('/profile', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'profilepage.html'));
});

// API endpoint to get user data including profile image
app.get('/api/user', async (req, res) => {
  if (req.session.userId) {
    try {
      // Fetch the user from the database to get the email
      const user = await User.findById(req.session.userId);
      
      if (!user) {
        return res.json({ isAuthenticated: false });
      }
      
      return res.json({ 
        isAuthenticated: true, 
        name: user.name,
        email: user.email,
        profileImage: user.profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=random`
      });
    } catch (error) {
      console.error('Error fetching user data:', error);
      return res.json({ 
        isAuthenticated: true, 
        name: req.session.userName,
        // Fallback if database query fails
        profileImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(req.session.userName)}&background=random`
      });
    }
  }
  res.json({ isAuthenticated: false });
});

// Add this API endpoint
app.get('/api/user/purchases', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const purchases = await Purchase.find({ userId }).sort({ purchaseDate: -1 });
    
    res.json({ 
      purchases: purchases.map(p => ({
        id: p._id,
        type: p.type,
        productName: p.productName,
        downloadLink: p.type === 'ebook' ? `/download/${p._id}` : null,
        packageHours: p.packageHours,
        amount: p.amount,
        currency: p.currency,
        purchaseDate: p.purchaseDate,
        status: p.status
      }))
    });
  } catch (error) {
    console.error('Error fetching user purchases:', error);
    res.status(500).json({ error: 'Failed to fetch purchases' });
  }
});

// Add a specific download endpoint for purchased eBooks
app.get('/download/:purchaseId', isAuthenticated, async (req, res, next) => {
  try {
    const purchaseId = req.params.purchaseId;
    const userId = req.session.userId;
    
    // Verify this purchase belongs to the user and is an ebook
    const purchase = await Purchase.findOne({ 
      _id: purchaseId, 
      userId: userId,
      type: 'ebook'
    });
    
    if (!purchase) {
      return res.status(404).send('Purchase not found or unauthorized');
    }
    
    // Get file path based on ebook name/ID (implement according to your system)
    const filePath = getEbookPath(purchase.productName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('E-book file not found');
    }
    
    const fileName = path.basename(filePath);
    
    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf'); // Adjust if needed
    
    // Create read stream with error handling
    const fileStream = fs.createReadStream(filePath);
    
    // Handle stream errors
    fileStream.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        return res.status(500).send('Error streaming file');
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      fileStream.destroy();
    });
    
    // Pipe file to response
    fileStream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      next(error);
    }
  }
});

// Helper function to map ebook names to file paths
function getEbookPath(ebookName) {
  // Example implementation - adjust based on your ebook files
  const ebookMap = {
    'ADHD Basics Guide': path.join(__dirname, 'ebooks', 'adhd-basics.pdf'),
    'Parenting Strategies': path.join(__dirname, 'ebooks', 'parenting-strategies.pdf'),
    // Add more mappings as needed
  };
  
  return ebookMap[ebookName] || null;
}

// Add an API to check if user is authenticated
app.get('/api/auth-status', (req, res) => {
  res.json({
    isAuthenticated: !!req.session.userId
  });
});

// Create Contact schema and model
const contactSchema = new mongoose.Schema({
  firstname: { type: String, required: true },
  lastname: { type: String, required: true },
  childName: String,
  childAge: Number,
  phone: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String, required: true },
  submittedAt: { type: Date, default: Date.now }
});

const Contact = mongoose.model('Contact', contactSchema);

// API endpoint for contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { firstname, lastname, childName, childAge, phone, email, message } = req.body;
    
    // Basic validation
    if (!firstname || !lastname || !phone || !email || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Veuillez remplir tous les champs obligatoires.'
      });
    }
    
    // Create new contact document
    const contact = new Contact({
      firstname,
      lastname,
      childName,
      childAge,
      phone,
      email,
      message
    });
    
    // Save to MongoDB
    await contact.save();
    
    // Send success response
    return res.status(200).json({
      success: true,
      message: 'Message envoyé avec succès! Nous vous contacterons bientôt.'
    });
    
  } catch (error) {
    console.error('Error saving contact:', error);
    return res.status(500).json({
      success: false,
      message: 'Une erreur s\'est produite lors de l\'envoi du message.'
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); 