// backend/server.js

require('dotenv').config(); // Load environment variables

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // For unique IDs
const os = require('os'); // To get local IP address
const { spawn } = require('child_process'); // To execute Python script
const path = require('path'); // To handle file paths

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*', // For development. Restrict in production.
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Environment Variables
const PORT = process.env.PORT || 4000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Destination Coordinates for Saveetha Engineering College
const DESTINATION_LAT = parseFloat(process.env.DESTINATION_LAT) || 13.02623981408621; // Provided Latitude
const DESTINATION_LNG = parseFloat(process.env.DESTINATION_LNG) || 80.01572347950078; // Provided Longitude

// In-memory storage for students
let students = {};

// In-memory storage for bus location (to be updated by driver)
let bus = {
  id: 'bus1',
  name: 'City Express',
  latitude: DESTINATION_LAT, // Initial Latitude set to College Location
  longitude: DESTINATION_LNG, // Initial Longitude set to College Location
  eta: null, // Estimated Time of Arrival (minutes)
};

// Function to get local IP address
const getLocalIpAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip over non-IPv4 and internal (i.e., 127.0.0.1) addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

// Declare chalk in the global scope
let chalk;

// Function to initialize the server with dynamic import of Chalk
const initializeServer = async () => {
  try {
    // Dynamically import Chalk (ESM module)
    const chalkModule = await import('chalk');
    chalk = chalkModule.default;

    // Socket.io Connection
    io.on('connection', (socket) => {
      console.log(chalk.green(`New client connected: ${socket.id}`));

      // Identify the user role upon connection
      socket.on('identify', (data) => {
        const { role, userId } = data;
        socket.role = role;
        socket.userId = userId;

        if (role === 'driver') {
          console.log(chalk.blue(`Driver connected: ${userId}`));
          // Optionally, associate socket with the driver
        } else if (role === 'student') {
          console.log(chalk.blue(`Student connected: ${userId}`));
          // Send current bus location to the newly connected student
          socket.emit('busLocationUpdate', bus);
        }
      });

      // Listen for bus location updates from the driver
      socket.on('busLocationUpdate', async (data) => {
        if (socket.role !== 'driver') {
          console.log(chalk.red(`Unauthorized bus location update from: ${socket.id}`));
          return;
        }

        const { latitude, longitude } = data;

        // Update bus location
        bus.latitude = latitude;
        bus.longitude = longitude;

        console.log(
          chalk.yellow(
            `Bus location updated to Latitude: ${latitude}, Longitude: ${longitude}`
          )
        );

        // Prepare input data for ETA prediction
        const currentTime = new Date().getHours() + new Date().getMinutes() / 60; // Current time in hours (e.g., 14.5 for 2:30 PM)

        // Get traffic level
        const traffic_level = await GET_TRAFFIC_LEVEL(latitude, longitude);

        const etaInput = {
          latitude: bus.latitude,
          longitude: bus.longitude,
          destination_lat: DESTINATION_LAT,
          destination_lng: DESTINATION_LNG,
          current_time: currentTime,
          traffic_level: traffic_level,
        };

        try {
          // Get ETA prediction
          const eta = await getEtaPrediction(etaInput);

          // Attach ETA to bus object
          bus.eta = eta;

          // Broadcast the updated bus location with ETA to all students
          io.emit('busLocationUpdate', bus);

          console.log(
            chalk.green(`ETA Prediction: ${eta} minutes Broadcasted to students.`)
          );
        } catch (error) {
          console.error(chalk.red('Error in ETA Prediction:'), error);
          // Optionally, emit the bus location without ETA
          io.emit('busLocationUpdate', bus);
        }
      });

      // Listen for student location updates
      socket.on('studentLocationUpdate', (data) => {
        if (socket.role !== 'student') {
          console.log(chalk.red(`Unauthorized student location update from: ${socket.id}`));
          return;
        }

        const { studentId, name, latitude, longitude } = data;
        console.log(
          chalk.yellow(
            `Received location from Student ID: ${studentId}, Name: ${name}, Latitude: ${latitude}, Longitude: ${longitude}`
          )
        );
        students[studentId] = { name, latitude, longitude };

        // Optionally, broadcast individual student locations if needed
        // io.emit('studentLocationUpdate', { studentId, name, latitude, longitude });
      });

      // Handle client disconnect
      socket.on('disconnect', () => {
        console.log(chalk.red(`Client disconnected: ${socket.id}`));
        if (socket.role === 'student' && socket.userId) {
          // Remove student from the list upon disconnect
          delete students[socket.userId];
          console.log(chalk.red(`Student ${socket.userId} removed from active list.`));
        }
      });
    });

    // Endpoint to fetch directions using Google Maps Directions API
    app.get('/directions', async (req, res) => {
      const { origin, destination } = req.query;

      // Validate query parameters
      if (!origin || !destination) {
        return res.status(400).json({
          error: 'Missing origin or destination parameters.',
        });
      }

      try {
        const response = await axios.get(
          `https://maps.googleapis.com/maps/api/directions/json`,
          {
            params: {
              origin,
              destination,
              key: GOOGLE_MAPS_API_KEY,
            },
          }
        );

        const data = response.data;

        if (data.status !== 'OK') {
          return res.status(400).json({
            error: data.status,
            message: data.error_message,
          });
        }

        // Send back the routes
        res.json(data.routes);
      } catch (error) {
        console.error(chalk.red('Error fetching directions:'), error.message);
        res.status(500).json({
          error: 'Failed to fetch directions.',
          message: error.message,
        });
      }
    });

    // Function to get ETA prediction from Python script
    const getEtaPrediction = (inputData) => {
      return new Promise((resolve, reject) => {
        // Path to the Python script
        const scriptPath = path.join(__dirname, 'predict_eta.py');

        // Path to the model file
        const modelPath = path.join(__dirname, 'eta_random_forest_model.joblib');

        // Spawn a child process to run the Python script
        const pythonProcess = spawn('python', [scriptPath, modelPath]);

        let dataString = '';
        let errorString = '';

        // Send input data as JSON via stdin
        pythonProcess.stdin.write(JSON.stringify(inputData));
        pythonProcess.stdin.end();

        // Collect data from stdout
        pythonProcess.stdout.on('data', (data) => {
          dataString += data.toString();
        });

        // Collect error messages from stderr
        pythonProcess.stderr.on('data', (data) => {
          errorString += data.toString();
        });

        // Handle process exit
        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            reject(`Python script exited with code ${code}: ${errorString}`);
          } else {
            try {
              const result = JSON.parse(dataString);
              resolve(result.eta);
            } catch (err) {
              reject(`Error parsing Python script output: ${err.message}`);
            }
          }
        });
      });
    };

    // Function to get traffic level based on bus location
    const GET_TRAFFIC_LEVEL = async (latitude, longitude) => {
      try {
        // Example: Using Google Maps Traffic API or any other traffic data source
        // Since Google Maps Traffic API isn't directly available, we'll simulate traffic levels
        // In a real-world scenario, integrate with a traffic data provider

        // Simulate traffic level as a random value between 1 and 5
        const traffic_level = Math.floor(Math.random() * 5) + 1;
        return traffic_level;

        /*
        // Example using Google Maps Traffic API (hypothetical endpoint)
        const response = await axios.get(
          'https://maps.googleapis.com/maps/api/traffic/json', // Replace with actual Traffic API endpoint
          {
            params: {
              location: `${latitude},${longitude}`,
              key: GOOGLE_MAPS_API_KEY,
            },
          }
        );

        // Process the response to determine traffic level
        // This is a placeholder; adjust based on actual API response
        const trafficData = response.data;
        if (trafficData.status === 'OK') {
          // Example: Extract traffic speed or congestion level
          const speed = trafficData.current_speed; // Adjust based on actual data
          // Determine traffic level based on speed
          if (speed > 60) return 1; // Light traffic
          if (speed > 30) return 3; // Moderate traffic
          return 5; // Heavy traffic
        } else {
          return 3; // Default to moderate traffic if API fails
        }
        */
      } catch (error) {
        console.error(chalk.red('Error fetching traffic data:'), error.message);
        return 3; // Default to moderate traffic on error
      }
    };

    // Function to calculate distance between two lat/lng points in meters
    const calculateDistance = (lat1, lon1, lat2, lon2) => {
      function toRad(x) {
        return (x * Math.PI) / 180;
      }

      const R = 6378137; // Earth’s mean radius in meter
      const dLat = toRad(lat2 - lat1);
      const dLong = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
          Math.cos(toRad(lat2)) *
          Math.sin(dLong / 2) *
          Math.sin(dLong / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const d = R * c;
      return d; // returns the distance in meter
    };

    // Define Geofence Radius in meters (e.g., 1000 meters = 1 km)
    const GEOFENCE_RADIUS = parseFloat(process.env.GEOFENCE_RADIUS) || 1000;

    // Start the server on all network interfaces
    server.listen(PORT, '0.0.0.0', () => {
      const localIp = getLocalIpAddress();
      console.log(chalk.magenta('-------------------------------------------------'));
      console.log(chalk.magenta('📢 Bus Tracking Application Server Started'));
      console.log(chalk.magenta('-------------------------------------------------'));
      console.log(chalk.green(`Listening on:`));
      console.log(chalk.blue(`- http://127.0.0.1:${PORT}`));
      console.log(chalk.blue(`- http://${localIp}:${PORT}`));
      console.log(chalk.magenta('-------------------------------------------------'));
    });
  } catch (error) {
    console.error('Failed to initialize Chalk:', error);
    process.exit(1); // Exit the process with failure
  }
};

// Initialize the server
initializeServer();
