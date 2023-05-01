const express = require('express');
const router = express.Router();
const { crawl } = require('./crawler');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const secretKey = 'TyFlY9qKzb9G1yMaKXigMdwbqD3bYKqoMWxuoBGgw34='; 
const mysql = require('mysql2/promise');
const app = express();
const path = require('path');
const fs = require('fs');


// Define rate limiting
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10, // limit each IP to 10 requests per windowMs
});


// Handle root route
router.get('/', (req, res) => {
  res.redirect('/swagger');
});

// Middleware function to validate URL
function validateUrl(req, res, next) {
  const { url } = req.body;
  if (!url) {
    return res.status(400).send('Missing required URL parameter');
  }
  try {
    new URL(url);
    next();
  } catch (error) {
    return res.status(400).send('Invalid URL parameter');
  }
}


// Route to register a new user
router.post('/register',
  body('email').isEmail(),
  body('password').isLength({ min: 8, max: 128 }), limiter,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).send('Email or Password is invalid, make sure the email is valid with a minimum password length of 8');

    }

    // Request body is valid, continue processing the registration
    const { email, password } = req.body;

    // Hash the password using bcrypt
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    try {
      // Connect to the MySQL database
      const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'kass',
        password: '021580881',
        database: 'users',
      });

      // Check if the user already exists in the database
      const [existingUsers] = await connection.execute(
        'SELECT * FROM users WHERE email = ?',
        [email]
      );

      if (existingUsers.length > 0) {
        // User already exists
        res.status(409).json({
          status: 'error',
          message: 'Email already exists. Please try another one.',
        });
      } else {
        // Insert the new user into the database with the hashed password
        const [result] = await connection.execute(
          'INSERT INTO users (email, password) VALUES (?, ?)',
          [email, hashedPassword]
        );

        // Check if the user was successfully inserted into the database
        if (result.affectedRows > 0) {
          res.status(200).send('Registration successful');
        } else {
          res.status(500).send('Error registering user');
        }
      }

      // Close the database connection
      await connection.end();
    } catch (error) {
      res.status(500).send('Error registering user: ' + error.message);
    }
  }
);



//Route to upload an auth file
const multer = require('multer');
const upload = multer({ dest: 'auth/auth-files/' });
router.post('/upload-auth', verifyJWT, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }

  const authId = req.file.filename;
  res.status(200).json({ message: 'File uploaded successfully', authId });
});


// Route to start crawl with input validation
router.post('/start-crawl', verifyJWT, validateUrl, limiter, async (req, res) => {
  const { auth_token, module, url, authId } = req.body;
  console.log(`POST request received with auth_token: ${auth_token}, module: ${module}, url: ${url}, authId: ${authId}`);

  // Check if the module is authorized to perform a crawl
  if (!isAuthorizedModule(module)) {
    res.status(401).send('Unauthorized module');
    return;
  }

  try {
    const auth = authId ? await loadAuthFromFile(authId) : null;
    await crawl(url, auth ? auth.filePath : null, (foundUrl) => { // Pass the auth.filePath instead of the whole auth object
    });
    res.status(200).send('Crawl finished');
  } catch (error) {
    res.status(500).send('Error during crawl: ' + error.message);
  }
});



async function uploadAuthFile(file) {
  const formData = new FormData();
  formData.append('auth', file);

  const response = await fetch('/upload-auth', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + your_jwt_token,
    },
    body: formData,
  });

  const result = await response.json();
  return result;
}

async function loadAuthFromFile(authId) {
  const authFilePath = path.join('auth/auth-files', authId);
  return new Promise((resolve, reject) => {
    fs.readFile(authFilePath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve({filePath: authFilePath, data: JSON.parse(data)});
      }
    });
  });
}


// Function to check if a module is authorized to perform a crawl
function isAuthorizedModule(module) {
  // Add your logic here to check if the module is authorized
  const authorizedModules = ['crawler'];
  return authorizedModules.includes(module);
}

// Route to login an existing user
router.post('/login', limiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send('Missing email or password');
  }

  // Connect to the MySQL database
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'kass',
    password: '021580881',
    database: 'users',
  });

  // Query the user from the database
  const [rows] = await connection.execute(
    'SELECT * FROM users WHERE email = ?',
    [email]
  );

  // Close the database connection
  await connection.end();

  if (rows.length === 0) {
    // User not found
    res.status(401).send('Invalid email or password');
    return;
  }

  // Use bcrypt to compare the password entered by the user with the hashed password in the database
  const user = rows[0];
  const passwordMatch = await bcrypt.compare(password, user.password);

  if (passwordMatch) {
    // User found, generate a JWT
    const token = jwt.sign({ id: user.id, email: user.email }, secretKey, { expiresIn: '9999d' });

    // Send the JWT to the client
    res.status(200).json({ message: 'Login successful', token });
  } else {
    // Passwords don't match
    res.status(401).send('Invalid email or password');
  }
});

// Route to get all users in the database
router.get('/users', verifyJWT, limiter, async (req, res) => {
  try {
    // Connect to the MySQL database
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'kass',
      password: '021580881',
      database: 'users',
    });

    // Query all users from the database
    const [rows] = await connection.execute('SELECT * FROM users');

    // Close the database connection
    await connection.end();

    res.status(200).json(rows);
  } catch (error) {
    res.status(500).send('Error retrieving users: ' + error.message);
  }
});

//Route to get a single user
router.get('/users/:userId', verifyJWT, limiter, async (req, res) => {
  const userId = req.params.userId;

  try {
    // Connect to the MySQL database
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'kass',
      password: '021580881',
      database: 'users',
    });

    // Query the user from the database
    const [rows] = await connection.execute('SELECT * FROM users WHERE id = ?', [userId]);

    // Close the database connection
    await connection.end();

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).send('User not found');
    }
  } catch (error) {
    res.status(500).send('Error retrieving user: ' + error.message);
  }
});

// Route to update a specific user credentials (email or password)
router.put('/users/:userId', verifyJWT, limiter, async (req, res) => {
  const userId = req.params.userId;
  const { email, password } = req.body;

  try {
    // Connect to the MySQL database
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'kass',
      password: '021580881',
      database: 'users',
    });

    // Update the user in the database
    const [result] = await connection.execute('UPDATE users SET email = ?, password = ? WHERE id = ?', [email, password, userId]);

    // Close the database connection
    await connection.end();

    if (result.affectedRows > 0) {
      res.status(200).send('User updated successfully');
    } else {
      res.status(404).send('User not found');
    }
  } catch (error) {
    res.status(500).send('Error updating user: ' + error.message);
  }
});

// Route to delete a user from the database
router.post('/users/:userId', verifyJWT, limiter, async (req, res) => {
  const userId = req.params.userId;

  try {
    // Connect to the MySQL database
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'kass',
      password: '021580881',
      database: 'users',
    });

    // Remove the user from the database
    const [result] = await connection.execute('DELETE FROM users WHERE id = ?', [userId]);

    // Close the database connection
    await connection.end();

    // Check if a user was removed
    if (result.affectedRows > 0) {
      res.status(200).send('User removed successfully');
    } else {
      res.status(404).send('User not found');
    }
  } catch (error) {
    res.status(500).send('Error removing user: ' + error.message);
  }
});

// Verify JWT 
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send('No token provided');
  }

  const token = authHeader.split(' ')[1]; 

  jwt.verify(token, secretKey, (err, decoded) => {
    if (err) {
      return res.status(403).send('Failed to authenticate token');
    }

    // Save the decoded user information to the request object
    req.userId = decoded.id;
    next();
  });
}

module.exports = router;
