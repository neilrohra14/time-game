const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory game store
const games = new Map();

function generateCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (games.has(code));
  return code;
}

function getPlayerList(game) {
  return Array.from(game.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    timeBank: p.timeBank,
    roundsWon: p.roundsWon,
  }));
}

function revealRound(game) {
  if (game.state !== 'round_active') return;
  game.state = 'round_reveal';

  const now = Date.now();

  // Finalize bids for players who never stopped (they get full elapsed or their timeBank)
  for (const [pid, roundBid] of game.roundBids.entries()) {
    if (!roundBid.stopped) {
      const player = game.players.get(pid);
      const elapsed = now - game.roundStartTime;
      roundBid.bid = Math.min(elapsed, player.timeBank);
      roundBid.stopped = true;
    }
  }

  // Build sorted bid list
  const bids = [];
  for (const [pid, roundBid] of game.roundBids.entries()) {
    const player = game.players.get(pid);
    bids.push({ id: pid, name: player.name, bid: roundBid.bid, skipped: roundBid.skipped || false });
  }
  bids.sort((a, b) => b.bid - a.bid);

  // Find winner(s)
  const maxBid = bids[0]?.bid ?? 0;
  const winners = bids.filter(b => b.bid === maxBid).map(b => b.name);
  const isTie = winners.length > 1;

  // Deduct bids from time banks and record wins
  for (const { id, bid } of bids) {
    const player = game.players.get(id);
    player.timeBank = Math.max(0, player.timeBank - bid);
    player.bidsHistory.push(bid);
    if (winners.includes(player.name)) {
      player.roundsWon++;
    }
  }

  const isLastRound = game.currentRound >= game.settings.rounds;

  const result = {
    round: game.currentRound,
    totalRounds: game.settings.rounds,
    winners,
    isTie,
    bids,
    players: getPlayerList(game),
    isLastRound,
  };

  game.results.push(result);
  io.to(game.code).emit('round_revealed', result);

  if (isLastRound) {
    endGame(game);
  }
}

function endGame(game) {
  game.state = 'finished';

  const players = Array.from(game.players.values()).slice();
  players.sort((a, b) => {
    if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon;
    return b.timeBank - a.timeBank;
  });

  io.to(game.code).emit('game_over', {
    winner: players[0]?.name ?? 'Nobody',
    leaderboard: players.map(p => ({
      name: p.name,
      roundsWon: p.roundsWon,
      timeRemaining: p.timeBank,
    })),
  });

  // Clean up after 2 hours
  setTimeout(() => games.delete(game.code), 7_200_000);
}

io.on('connection', (socket) => {

  // ── Admin creates a game ──────────────────────────────────────────────────
  socket.on('create_game', ({ totalTime, rounds }) => {
    const code = generateCode();
    const game = {
      code,
      adminId: socket.id,
      settings: {
        totalTime: Math.max(60, Math.min(3600, parseInt(totalTime) || 600)),
        rounds: Math.max(1, Math.min(50, parseInt(rounds) || 19)),
      },
      players: new Map(),
      state: 'lobby',
      currentRound: 0,
      roundBids: new Map(),
      roundStartTime: null,
      results: [],
    };

    games.set(code, game);
    socket.join(code);
    socket.data.gameCode = code;
    socket.data.isAdmin = true;

    socket.emit('game_created', { code, settings: game.settings });
  });

  // ── Admin reconnects (page refresh) ──────────────────────────────────────
  socket.on('admin_reconnect', ({ code }) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game) return socket.emit('error', { message: 'Game not found.' });

    game.adminId = socket.id;
    socket.join(code);
    socket.data.gameCode = code;
    socket.data.isAdmin = true;

    socket.emit('admin_reconnected', {
      code: game.code,
      settings: game.settings,
      state: game.state,
      currentRound: game.currentRound,
      roundStartTime: game.roundStartTime,
      players: getPlayerList(game),
      results: game.results,
    });
  });

  // ── Player joins or rejoins (unified — handles fresh join, lobby reconnect,
  //    and mid-game reconnect transparently) ──────────────────────────────────
  socket.on('join_game', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim().substring(0, 20);

    if (!code || !name) return socket.emit('error', { message: 'Code and name are required.' });

    const game = games.get(code);
    if (!game) return socket.emit('error', { message: 'Game not found. Check the code and try again.' });

    // Find any existing player slot with this name
    let existingId = null;
    for (const [pid, player] of game.players.entries()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        existingId = pid;
        break;
      }
    }

    if (game.state === 'lobby') {
      if (existingId && existingId !== socket.id) {
        // Reconnect during lobby: transfer slot to new socket
        const player = game.players.get(existingId);
        game.players.delete(existingId);
        player.id = socket.id;
        game.players.set(socket.id, player);
      } else if (!existingId) {
        // Fresh join
        game.players.set(socket.id, {
          id: socket.id,
          name,
          timeBank: game.settings.totalTime * 1000,
          bidsHistory: [],
          roundsWon: 0,
        });
      }

      socket.join(code);
      socket.data.gameCode = code;
      socket.data.isAdmin = false;
      socket.data.playerName = name;

      socket.emit('joined', { code, name, settings: game.settings, players: getPlayerList(game) });
      io.to(code).emit('lobby_update', { players: getPlayerList(game) });

    } else {
      // Game in progress — must be a reconnect
      if (!existingId) return socket.emit('error', { message: 'Game already in progress and your name was not found.' });

      // Transfer player slot to new socket
      const player = game.players.get(existingId);
      game.players.delete(existingId);
      player.id = socket.id;
      game.players.set(socket.id, player);

      if (game.roundBids.has(existingId)) {
        const bid = game.roundBids.get(existingId);
        game.roundBids.delete(existingId);
        game.roundBids.set(socket.id, bid);
      }

      socket.join(code);
      socket.data.gameCode = code;
      socket.data.isAdmin = false;
      socket.data.playerName = name;

      socket.emit('rejoined', {
        code,
        name,
        settings: game.settings,
        state: game.state,
        currentRound: game.currentRound,
        totalRounds: game.settings.rounds,
        players: getPlayerList(game),
        timeBank: player.timeBank,
        roundsWon: player.roundsWon,
        roundStartTime: game.roundStartTime,
        myBid: game.roundBids.get(socket.id) || null,
        lastResult: game.results[game.results.length - 1] || null,
      });
    }
  });

  // ── Legacy rejoin alias (kept for safety) ────────────────────────────────
  socket.on('rejoin_game', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();

    const game = games.get(code);
    if (!game) return socket.emit('error', { message: 'Game not found.' });

    let existingId = null;
    for (const [pid, player] of game.players.entries()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        existingId = pid;
        break;
      }
    }

    if (!existingId) return socket.emit('error', { message: 'Player not found in this game.' });

    const player = game.players.get(existingId);
    game.players.delete(existingId);
    player.id = socket.id;
    game.players.set(socket.id, player);

    if (game.roundBids.has(existingId)) {
      const bid = game.roundBids.get(existingId);
      game.roundBids.delete(existingId);
      game.roundBids.set(socket.id, bid);
    }

    socket.join(code);
    socket.data.gameCode = code;
    socket.data.isAdmin = false;
    socket.data.playerName = name;

    socket.emit('rejoined', {
      code,
      name,
      settings: game.settings,
      state: game.state,
      currentRound: game.currentRound,
      totalRounds: game.settings.rounds,
      players: getPlayerList(game),
      timeBank: player.timeBank,
      roundsWon: player.roundsWon,
      roundStartTime: game.roundStartTime,
      myBid: game.roundBids.get(socket.id) || null,
      lastResult: game.results[game.results.length - 1] || null,
    });
  });

  // ── Admin starts a round ──────────────────────────────────────────────────
  socket.on('start_round', () => {
    const game = games.get(socket.data.gameCode);
    if (!game || socket.id !== game.adminId) return;
    if (game.state !== 'lobby' && game.state !== 'round_reveal') return;
    if (game.players.size === 0) return socket.emit('error', { message: 'No players have joined yet.' });
    if (game.currentRound >= game.settings.rounds) return;

    game.currentRound++;
    game.state = 'round_active';
    game.roundBids = new Map();
    game.roundStartTime = Date.now();

    for (const pid of game.players.keys()) {
      const player = game.players.get(pid);
      // Players with 0 time bank are immediately stopped
      game.roundBids.set(pid, {
        stopped: player.timeBank === 0,
        bid: player.timeBank === 0 ? 0 : null,
      });
    }

    io.to(game.code).emit('round_started', {
      round: game.currentRound,
      totalRounds: game.settings.rounds,
      serverTime: game.roundStartTime,
    });
  });

  // ── Player stops their timer ──────────────────────────────────────────────
  socket.on('player_stop', () => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.state !== 'round_active') return;
    if (!game.players.has(socket.id)) return;

    const roundBid = game.roundBids.get(socket.id);
    if (!roundBid || roundBid.stopped) return;

    const now = Date.now();
    const player = game.players.get(socket.id);
    const elapsed = now - game.roundStartTime;
    const bid = Math.min(elapsed, player.timeBank);

    roundBid.stopped = true;
    roundBid.bid = bid;

    socket.emit('bid_recorded', { bid });

    const stoppedCount = Array.from(game.roundBids.values()).filter(b => b.stopped).length;
    const totalPlayers = game.players.size;

    io.to(game.adminId).emit('bidding_progress', {
      stoppedCount,
      totalPlayers,
      playerName: player.name,
    });

    // Auto-reveal when everyone has stopped
    if (stoppedCount === totalPlayers) {
      setTimeout(() => revealRound(game), 800);
    }
  });

  // ── Player skips the round (0 time deducted, only in first 10s) ──────────
  socket.on('player_skip', () => {
    const game = games.get(socket.data.gameCode);
    if (!game || game.state !== 'round_active') return;
    if (!game.players.has(socket.id)) return;

    const roundBid = game.roundBids.get(socket.id);
    if (!roundBid || roundBid.stopped) return;

    // Enforce 10-second skip window server-side
    if (Date.now() - game.roundStartTime > 10000) return;

    roundBid.stopped = true;
    roundBid.bid = 0;
    roundBid.skipped = true;

    const player = game.players.get(socket.id);
    socket.emit('bid_recorded', { bid: 0, skipped: true });

    const stoppedCount = Array.from(game.roundBids.values()).filter(b => b.stopped).length;
    io.to(game.adminId).emit('bidding_progress', {
      stoppedCount,
      totalPlayers: game.players.size,
      playerName: player.name,
    });

    if (stoppedCount === game.players.size) {
      setTimeout(() => revealRound(game), 800);
    }
  });

  // ── Admin forces reveal ───────────────────────────────────────────────────
  socket.on('reveal_round', () => {
    const game = games.get(socket.data.gameCode);
    if (!game || socket.id !== game.adminId) return;
    revealRound(game);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const game = games.get(socket.data.gameCode);
    if (!game) return;

    if (socket.id === game.adminId) {
      io.to(game.code).emit('admin_disconnected');
    } else if (game.state === 'lobby' && game.players.has(socket.id)) {
      const name = game.players.get(socket.id).name;
      game.players.delete(socket.id);
      io.to(game.code).emit('lobby_update', { players: getPlayerList(game) });
    } else if (game.state === 'round_active' && game.roundBids.has(socket.id)) {
      // Force-stop disconnected player mid-round
      const roundBid = game.roundBids.get(socket.id);
      if (!roundBid.stopped) {
        const player = game.players.get(socket.id);
        const elapsed = Date.now() - game.roundStartTime;
        roundBid.bid = Math.min(elapsed, player.timeBank);
        roundBid.stopped = true;

        const stoppedCount = Array.from(game.roundBids.values()).filter(b => b.stopped).length;
        if (stoppedCount === game.players.size) {
          setTimeout(() => revealRound(game), 800);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Time Auction running on http://localhost:${PORT}`);
});
