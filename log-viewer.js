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

// Function to parse and format slots data with detailed log format
function formatSlotsData(rawData) {
  try {
    const parsed = JSON.parse(rawData);
    let formatted = '';

    if (Array.isArray(parsed) && parsed.length > 0) {
      formatted += `📊 SLOT STATUS REPORT 📊\n`;
      formatted += `==========================\n`;
      formatted += `Total Slots: ${parsed.length}\n\n`;

      parsed.forEach((slot, index) => {
        formatted += `📋 SLOT ${index + 1}:\n`;
        formatted += `==================\n`;
        formatted += `ID: ${slot.id}\n`;
        formatted += `Context Size: ${slot.n_ctx.toLocaleString()} tokens\n`;
        formatted += `Speculative: ${slot.speculative ? '✅ ON' : '❌ OFF'}\n`;
        formatted += `Processing: ${slot.is_processing ? '🔄 ACTIVE' : '✅ IDLE'}\n`;
        formatted += `Task ID: ${slot.id_task}\n\n`;

        // Key parameters
        formatted += `🔧 PARAMETERS:\n`;
        formatted += `--------------\n`;
        formatted += `Temperature: ${slot.params.temperature}\n`;
        formatted += `Top-K: ${slot.params.top_k}\n`;
        formatted += `Top-P: ${slot.params.top_p}\n`;
        formatted += `Max Tokens: ${slot.params.max_tokens.toLocaleString()}\n`;
        formatted += `N Predict: ${slot.params.n_predict.toLocaleString()}\n`;
        formatted += `Chat Format: ${slot.params.chat_format}\n\n`;

        // Next token status
        formatted += `🚀 NEXT TOKEN STATUS:\n`;
        formatted += `---------------------\n`;
        if (slot.next_token && slot.next_token.length > 0) {
          formatted += `Has Next Token: ${slot.next_token[0].has_next_token ? '✅ YES' : '❌ NO'}\n`;
          formatted += `Tokens Remaining: ${slot.next_token[0].n_remain.toLocaleString()}\n`;
          formatted += `Tokens Decoded: ${slot.next_token[0].n_decoded}\n`;
        } else {
          formatted += `No next token info available\n`;
        }
        formatted += `\n────────────────────────────────\n\n`;
      });
    } else {
      // Fallback to basic JSON formatting
      formatted = JSON.stringify(parsed, null, 2);
    }

    return formatted;
  } catch (e) {
    return rawData;
  }
}

// Function to parse and format health data with detailed log format
function formatHealthData(rawData) {
  try {
    const parsed = JSON.parse(rawData);
    let formatted = '';

    // Handle health structure with detailed formatting
    formatted += `🏥 SERVER HEALTH REPORT 🏥\n`;
    formatted += `==========================\n`;

    if (parsed.status) {
      formatted += `Status: ${parsed.status.toUpperCase()}\n`;
    }

    if (parsed.uptime) {
      formatted += `Uptime: ${parsed.uptime}\n`;
    }

    if (parsed.memory) {
      formatted += `\n💾 MEMORY USAGE:\n`;
      formatted += `-----------------\n`;
      Object.keys(parsed.memory).forEach(key => {
        formatted += `${key}: ${parsed.memory[key]}\n`;
      });
    }

    if (parsed.gpu) {
      formatted += `\n🖥️  GPU INFORMATION:\n`;
      formatted += `-------------------\n`;
      Object.keys(parsed.gpu).forEach(key => {
        formatted += `${key}: ${parsed.gpu[key]}\n`;
      });
    }

    if (parsed.model) {
      formatted += `\n🤖 MODEL INFORMATION:\n`;
      formatted += `---------------------\n`;
      Object.keys(parsed.model).forEach(key => {
        formatted += `${key}: ${parsed.model[key]}\n`;
      });
    }

    if (parsed.system) {
      formatted += `\n💻 SYSTEM INFORMATION:\n`;
      formatted += `----------------------\n`;
      Object.keys(parsed.system).forEach(key => {
        formatted += `${key}: ${parsed.system[key]}\n`;
      });
    }

    if (parsed.version) {
      formatted += `\n🔢 VERSION:\n`;
      formatted += `------------\n`;
      formatted += `Version: ${parsed.version}\n`;
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