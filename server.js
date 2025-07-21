const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for your GitHub Pages domain
const io = socketIo(server, {
    cors: {
        origin: [
        "https://amrik-majumdar.github.io",
        "http://localhost:3000",
        "http://127.0.0.1:5500" // For local development,
        "https://mao-hois.onrender.com"
    ],
        methods: ["GET", "POST"]
    }
});

app.use(cors({
    origin: [
        "https://amrik-majumdar.github.io",
        "http://localhost:3000",
        "http://127.0.0.1:5500",
        "https://mao-hois.onrender.com"
    ]
}));

app.use(express.json());

// Game state management
const games = new Map();
const playerSockets = new Map();

// Card definitions
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
    }
}

class Game {
    constructor(roomCode, hostName) {
        this.roomCode = roomCode;
        this.players = [{
            name: hostName,
            isHost: true,
            socketId: null,
            hand: [],
            cardCount: 0
        }];
        this.deck = [];
        this.discardPile = [];
        this.currentPlayerIndex = 0;
        this.gameActive = false;
        this.customRules = [];
        this.penaltyLog = [];
        this.pointOfOrderActive = false;
        this.pointOfOrderCaller = null;
        this.chatMuted = true;
        this.declaredSuit = null; // For when Jacks are played
        this.createdAt = Date.now();
    }

    addPlayer(playerName, socketId) {
        if (this.players.length >= 10) {
            return { success: false, error: 'Room is full' };
        }

        if (this.players.some(p => p.name === playerName)) {
            return { success: false, error: 'Name already taken' };
        }

        this.players.push({
            name: playerName,
            isHost: false,
            socketId: socketId,
            hand: [],
            cardCount: 0
        });

        return { success: true };
    }

    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.socketId === socketId);
        if (playerIndex === -1) return false;

        const player = this.players[playerIndex];
        this.players.splice(playerIndex, 1);

        // If host left, make next player host
        if (player.isHost && this.players.length > 0) {
            this.players[0].isHost = true;
        }

        return true;
    }

    generateDeck() {
        this.deck = [];
        for (let suit of SUITS) {
            for (let rank of RANKS) {
                this.deck.push(new Card(suit, rank));
            }
        }
        this.shuffleDeck();
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        const cardsPerPlayer = 4;
        
        for (let player of this.players) {
            player.hand = [];
            for (let i = 0; i < cardsPerPlayer; i++) {
                if (this.deck.length > 0) {
                    player.hand.push(this.deck.pop());
                }
            }
            player.cardCount = player.hand.length;
        }

        // Place first card on discard pile
        if (this.deck.length > 0) {
            this.discardPile = [this.deck.pop()];
        }
    }

    startGame() {
        if (this.players.length < 2) {
            return { success: false, error: 'Need at least 2 players' };
        }

        this.generateDeck();
        this.dealCards();
        this.currentPlayerIndex = 0;
        this.gameActive = true;
        this.chatMuted = true;

        return { success: true };
    }

    getCurrentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    getNextPlayerIndex() {
        return (this.currentPlayerIndex + 1) % this.players.length;
    }

    nextTurn() {
        this.currentPlayerIndex = this.getNextPlayerIndex();
    }

    canPlayCard(player, card) {
        if (!this.gameActive) return false;
        if (this.getCurrentPlayer().name !== player.name) return false;
        if (this.discardPile.length === 0) return false;

        const topCard = this.discardPile[0];
        const effectiveSuit = this.declaredSuit || topCard.suit;

        return card.suit === effectiveSuit || 
               card.rank === topCard.rank || 
               card.rank === 'J'; // Jacks are wild
    }

    playCard(playerName, card, specialData = {}) {
        const player = this.players.find(p => p.name === playerName);
        if (!player) return { success: false, error: 'Player not found' };

        const cardInHand = player.hand.find(c => c.suit === card.suit && c.rank === card.rank);
        if (!cardInHand) return { success: false, error: 'Card not in hand' };

        if (!this.canPlayCard(player, card)) {
            return { success: false, error: 'Cannot play this card' };
        }

        // Remove card from hand
        player.hand = player.hand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
        player.cardCount = player.hand.length;

        // Add to discard pile
        this.discardPile.unshift(card);

        // Handle special cards
        if (card.rank === 'J' && specialData.declaredSuit) {
            this.declaredSuit = specialData.declaredSuit;
        } else {
            this.declaredSuit = null;
        }

        // Check for win condition
        if (player.hand.length === 0) {
            return { success: true, winner: playerName };
        }

        // Move to next player
        this.nextTurn();

        return { success: true };
    }

    drawCard(playerName) {
        const player = this.players.find(p => p.name === playerName);
        if (!player) return { success: false, error: 'Player not found' };

        if (this.getCurrentPlayer().name !== playerName) {
            return { success: false, error: 'Not your turn' };
        }

        if (this.deck.length === 0) {
            // Reshuffle discard pile into deck (keep top card)
            if (this.discardPile.length <= 1) {
                return { success: false, error: 'No cards available' };
            }

            const topCard = this.discardPile.shift();
            this.deck = [...this.discardPile];
            this.discardPile = [topCard];
            this.shuffleDeck();
        }

        const drawnCard = this.deck.pop();
        player.hand.push(drawnCard);
        player.cardCount = player.hand.length;

        return { success: true, card: drawnCard };
    }

    givePenalty(giver, receiver, reason) {
        const receiverPlayer = this.players.find(p => p.name === receiver);
        if (!receiverPlayer) return { success: false, error: 'Player not found' };

        // Add penalty card
        if (this.deck.length === 0) {
            // Reshuffle if needed
            if (this.discardPile.length > 1) {
                const topCard = this.discardPile.shift();
                this.deck = [...this.discardPile];
                this.discardPile = [topCard];
                this.shuffleDeck();
            }
        }

        if (this.deck.length > 0) {
            receiverPlayer.hand.push(this.deck.pop());
            receiverPlayer.cardCount = receiverPlayer.hand.length;
        }

        const penalty = {
            giver,
            receiver,
            reason,
            timestamp: Date.now()
        };

        this.penaltyLog.push(penalty);
        return { success: true, penalty };
    }

    callPointOfOrder(playerName) {
        if (this.pointOfOrderActive) return { success: false, error: 'Point of Order already active' };

        this.pointOfOrderActive = true;
        this.pointOfOrderCaller = playerName;
        this.chatMuted = false;

        return { success: true };
    }

    endPointOfOrder() {
        this.pointOfOrderActive = false;
        this.pointOfOrderCaller = null;
        this.chatMuted = true;

        return { success: true };
    }

    addCustomRule(creator, rule) {
        this.customRules.push({
            creator,
            rule,
            timestamp: Date.now()
        });

        return { success: true };
    }

    getPlayerData(playerName) {
        const player = this.players.find(p => p.name === playerName);
        return player ? {
            hand: player.hand,
            cardCount: player.cardCount
        } : null;
    }

    getPublicGameState() {
        return {
            roomCode: this.roomCode,
            players: this.players.map(p => ({
                name: p.name,
                isHost: p.isHost,
                cardCount: p.cardCount
            })),
            currentPlayer: this.getCurrentPlayer()?.name,
            discardPile: this.discardPile,
            gameActive: this.gameActive,
            penaltyLog: this.penaltyLog,
            pointOfOrderActive: this.pointOfOrderActive,
            pointOfOrderCaller: this.pointOfOrderCaller,
            chatMuted: this.chatMuted,
            declaredSuit: this.declaredSuit,
            customRuleCount: this.customRules.length
        };
    }
}

// Utility functions
function generateRoomCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Clean up old games (older than 24 hours)
setInterval(() => {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;
    
    for (let [roomCode, game] of games.entries()) {
        if (now - game.createdAt > dayInMs) {
            games.delete(roomCode);
        }
    }
}, 60 * 60 * 1000); // Run every hour

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createParty', (data) => {
        const roomCode = generateRoomCode();
        const game = new Game(roomCode, data.playerName);
        
        // Update player socket ID
        game.players[0].socketId = socket.id;
        games.set(roomCode, game);
        playerSockets.set(socket.id, { roomCode, playerName: data.playerName });

        socket.join(roomCode);
        
        socket.emit('partyCreated', {
            roomCode: roomCode,
            players: game.players.map(p => ({ name: p.name, isHost: p.isHost }))
        });

        console.log(`Party created: ${roomCode} by ${data.playerName}`);
    });

    socket.on('joinParty', (data) => {
        const game = games.get(data.roomCode);
        if (!game) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        const result = game.addPlayer(data.playerName, socket.id);
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        playerSockets.set(socket.id, { roomCode: data.roomCode, playerName: data.playerName });
        socket.join(data.roomCode);

        socket.emit('partyJoined', {
            roomCode: data.roomCode,
            players: game.players.map(p => ({ name: p.name, isHost: p.isHost }))
        });

        socket.to(data.roomCode).emit('playerJoined', {
            playerName: data.playerName,
            players: game.players.map(p => ({ name: p.name, isHost: p.isHost }))
        });

        console.log(`${data.playerName} joined party ${data.roomCode}`);
    });

    socket.on('startGame', () => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        const player = game.players.find(p => p.name === playerData.playerName);
        if (!player || !player.isHost) {
            socket.emit('error', { message: 'Only host can start the game' });
            return;
        }

        const result = game.startGame();
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        // Send individual hands to each player
        for (let gamePlayer of game.players) {
            const playerSocket = [...playerSockets.entries()]
                .find(([_, data]) => data.playerName === gamePlayer.name)?.[0];
            
            if (playerSocket) {
                io.to(playerSocket).emit('gameStarted', {
                    hand: gamePlayer.hand,
                    ...game.getPublicGameState()
                });
            }
        }

        console.log(`Game started in room ${playerData.roomCode}`);
    });

    socket.on('playCard', (data) => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        const result = game.playCard(playerData.playerName, data.card, data.specialData);
        
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        if (result.winner) {
            io.to(playerData.roomCode).emit('playerWon', {
                winner: result.winner,
                gameState: game.getPublicGameState()
            });

            // Send updated hands to all players
            for (let gamePlayer of game.players) {
                const playerSocket = [...playerSockets.entries()]
                    .find(([_, data]) => data.playerName === gamePlayer.name)?.[0];
                
                if (playerSocket) {
                    io.to(playerSocket).emit('handUpdate', {
                        hand: gamePlayer.hand
                    });
                }
            }
        } else {
            io.to(playerData.roomCode).emit('cardPlayed', {
                player: playerData.playerName,
                card: data.card,
                gameState: game.getPublicGameState()
            });

            // Send updated hands to all players
            for (let gamePlayer of game.players) {
                const playerSocket = [...playerSockets.entries()]
                    .find(([_, data]) => data.playerName === gamePlayer.name)?.[0];
                
                if (playerSocket) {
                    io.to(playerSocket).emit('handUpdate', {
                        hand: gamePlayer.hand
                    });
                }
            }
        }
    });

    socket.on('drawCard', () => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        const result = game.drawCard(playerData.playerName);
        
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        socket.emit('cardDrawn', {
            card: result.card,
            hand: game.getPlayerData(playerData.playerName).hand
        });

        socket.to(playerData.roomCode).emit('playerDrewCard', {
            player: playerData.playerName,
            gameState: game.getPublicGameState()
        });
    });

    socket.on('givePenalty', (data) => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        const result = game.givePenalty(data.giver, data.receiver, data.reason);
        
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        io.to(playerData.roomCode).emit('penaltyGiven', result.penalty);

        // Send updated hand to penalized player
        const penalizedPlayerSocket = [...playerSockets.entries()]
            .find(([_, data]) => data.playerName === result.penalty.receiver)?.[0];
        
        if (penalizedPlayerSocket) {
            const playerData = game.getPlayerData(result.penalty.receiver);
            io.to(penalizedPlayerSocket).emit('handUpdate', {
                hand: playerData.hand
            });
        }
    });

    socket.on('callPointOfOrder', (data) => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        const result = game.callPointOfOrder(data.player);
        
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }

        io.to(playerData.roomCode).emit('pointOfOrderCalled', {
            player: data.player,
            gameState: game.getPublicGameState()
        });
    });

    socket.on('endPointOfOrder', () => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        game.endPointOfOrder();

        io.to(playerData.roomCode).emit('pointOfOrderEnded', {
            gameState: game.getPublicGameState()
        });
    });

    socket.on('addNewRule', (data) => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        game.addCustomRule(data.creator, data.rule);

        io.to(playerData.roomCode).emit('newRuleAdded', {
            creator: data.creator,
            ruleCount: game.customRules.length
        });
    });

    socket.on('chatMessage', (data) => {
        const playerData = playerSockets.get(socket.id);
        if (!playerData) return;

        const game = games.get(playerData.roomCode);
        if (!game) return;

        // Check if chat is allowed
        if (game.chatMuted && !game.pointOfOrderActive) {
            socket.emit('error', { message: 'Chat is muted during gameplay' });
            return;
        }

        io.to(playerData.roomCode).emit('chatMessage', {
            player: data.player,
            message: data.message,
            timestamp: Date.now()
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const playerData = playerSockets.get(socket.id);
        if (playerData) {
            const game = games.get(playerData.roomCode);
            if (game) {
                game.removePlayer(socket.id);
                
                if (game.players.length === 0) {
                    games.delete(playerData.roomCode);
                    console.log(`Game ${playerData.roomCode} deleted - no players left`);
                } else {
                    socket.to(playerData.roomCode).emit('playerLeft', {
                        playerName: playerData.playerName,
                        players: game.players.map(p => ({ name: p.name, isHost: p.isHost }))
                    });
                }
            }
            
            playerSockets.delete(socket.id);
        }
    });
});

// Basic health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Mao Game Server is running!',
        activeGames: games.size,
        activePlayers: playerSockets.size
    });
});

// Get game statistics
app.get('/stats', (req, res) => {
    res.json({
        activeGames: games.size,
        activePlayers: playerSockets.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Mao game server running on port ${PORT}`);
});
