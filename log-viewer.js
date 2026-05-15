const express = require('express');
const { exec } = require('child_process');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Function to start journalctl and stream logs
function startLogStream() {
  const journalctl = exec('journalctl --user -u llama-server -f', { encoding: 'utf8' });

  journalctl.stdout.on('data', (data) => {
    // Send each log line to connected clients
    io.emit('log', data);
  });

  journalctl.stderr.on('data', (data) => {
    // Send error messages to clients
    io.emit('log', `[ERROR] ${data}`);
  });

  journalctl.on('close', (code) => {
    io.emit('log', `[INFO] journalctl process exited with code ${code}`);
  });
}

// Function to parse and format slots data
function formatSlotsData(rawData) {
  try {
    const parsed = JSON.parse(rawData);
    let formatted = '';

    // Handle different slot structures
    if (parsed.slots && Array.isArray(parsed.slots)) {
      formatted += `Slots Status:\n`;
      formatted += `Total Slots: ${parsed.slots.length}\n`;
      formatted += `----------------------------------------\n`;

      parsed.slots.forEach((slot, index) => {
        formatted += `Slot ${index + 1}:\n`;
        Object.keys(slot).forEach(key => {
          formatted += `  ${key}: ${slot[key]}\n`;
        });
        formatted += `\n`;
      });
    } else if (parsed.status) {
      formatted += `Status: ${parsed.status}\n`;
    } else {
      // Fallback to basic JSON formatting
      formatted = JSON.stringify(parsed, null, 2);
    }

    return formatted;
  } catch (e) {
    return rawData;
  }
}

// Function to parse and format health data
function formatHealthData(rawData) {
  try {
    const parsed = JSON.parse(rawData);
    let formatted = '';

    // Handle health structure
    if (parsed.status) {
      formatted += `Health Status: ${parsed.status}\n`;
    }

    if (parsed.uptime) {
      formatted += `Uptime: ${parsed.uptime}\n`;
    }

    if (parsed.memory) {
      formatted += `Memory:\n`;
      Object.keys(parsed.memory).forEach(key => {
        formatted += `  ${key}: ${parsed.memory[key]}\n`;
      });
    }

    if (parsed.gpu) {
      formatted += `GPU:\n`;
      Object.keys(parsed.gpu).forEach(key => {
        formatted += `  ${key}: ${parsed.gpu[key]}\n`;
      });
    }

    if (parsed.model) {
      formatted += `Model Info:\n`;
      Object.keys(parsed.model).forEach(key => {
        formatted += `  ${key}: ${parsed.model[key]}\n`;
      });
    }

    if (parsed.system) {
      formatted += `System Info:\n`;
      Object.keys(parsed.system).forEach(key => {
        formatted += `  ${key}: ${parsed.system[key]}\n`;
      });
    }

    if (Object.keys(parsed).length === 0) {
      // If no specific structure, fallback to JSON
      formatted = JSON.stringify(parsed, null, 2);
    }

    return formatted;
  } catch (e) {
    return rawData;
  }
}

// Function to fetch and stream /slots and /health data
function startStatusStream() {
  // Function to fetch slots data
  function fetchSlots() {
    exec('curl -s http://localhost:8080/slots', { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        io.emit('slots', `[ERROR] ${error.message}`);
      } else if (stderr) {
        io.emit('slots', `[ERROR] ${stderr}`);
      } else {
        const formatted = formatSlotsData(stdout);
        io.emit('slots', formatted);
      }
    });
  }

  // Function to fetch health data
  function fetchHealth() {
    exec('curl -s http://localhost:8080/health', { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        io.emit('health', `[ERROR] ${error.message}`);
      } else if (stderr) {
        io.emit('health', `[ERROR] ${stderr}`);
      } else {
        const formatted = formatHealthData(stdout);
        io.emit('health', formatted);
      }
    });
  }

  // Fetch data immediately and then every 5 seconds
  fetchSlots();
  fetchHealth();

  setInterval(() => {
    fetchSlots();
    fetchHealth();
  }, 5000);
}

// Start the log stream when server starts
startLogStream();

// Start the status stream
startStatusStream();

// Start the server on fixed port 4000
const PORT = 4000;

server.listen(PORT, () => {
  console.log(`Log viewer server running on port ${PORT}`);
  console.log(`Please open your browser and navigate to: http://localhost:${PORT}`);
  console.log('The log viewer will display:');
  console.log('  - Real-time logs from llama-server service');
  console.log('  - /slots and /health status from distrobox');
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});