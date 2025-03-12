const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  // Store the original URL they were trying to access
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
};

const isGuest = (req, res, next) => {
  if (!req.session.userId) {
    return next();
  }
  res.redirect('/');
};

module.exports = {
  isAuthenticated,
  isGuest
}; 