// Preload dotenv before ES module imports evaluate
require('dotenv').config({
  path: require('path').join(__dirname, '.env')
});

// Now load the actual server (ES module)
import('./dist/index.js');
