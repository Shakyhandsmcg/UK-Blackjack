const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function createFreshDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let value of VALUES) {
            deck.push({ suit, value, isJoker: false, displayValue: value, displaySuit: suit, playedBy: "System", playerColor: "#aaa" });
        }
    }
    deck.push({ suit: 'Joker', value: 'Joker', isJoker: true, displayValue: '🃏', displaySuit: '🃏', playedBy: "System", playerColor: "#aaa" });
    deck.push({ suit: 'Joker', value: 'Joker', isJoker: true, displayValue: '🃏', displaySuit: '🃏', playedBy: "System", playerColor: "#aaa" });
    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function permute(arr) {
    let res = [];
    function helper(current, remaining) {
        if (remaining.length === 0) {
            res.push(current);
            return;
        }
        for (let i = 0; i < remaining.length; i++) {
            let nextCurrent = current.concat([remaining[i]]);
            let nextRemaining = remaining.slice(0, i).concat(remaining.slice(i + 1));
            helper(nextCurrent, nextRemaining);
        }
    }
    helper([], arr);
    return res;
}

function isPickupCard(card) {
    if (card.displayValue === '2') return true;
    if (card.displayValue === 'J' && (card.displaySuit === '♠' || card.displaySuit === '♣')) return true;
    return false;
}

function isValidStep(card, activeVal, activeSuit, suitOverride, isFirstCard) {
    if (isFirstCard && card.displayValue === 'A') return true;
    if (card.displayValue === activeVal) return true;
    
    let targetSuit = (isFirstCard && suitOverride !== null) ? suitOverride : activeSuit;
    if (card.displaySuit === targetSuit) return true;
    
    if (card.displayValue === 'Q' || activeVal === 'Q') {
        if (isFirstCard) return (card.displaySuit === targetSuit || card.displayValue === activeVal);
        return true;
    }
    return false;
}

function getValidPermutation(cards, room) {
    let currentTop = room.playedStack[room.playedStack.length - 1];
    let initialSuit = currentTop.displaySuit;
    let initialVal = currentTop.displayValue;
    let initialOverride = room.activeSuitOverride;

    if (room.activePickupCount > 0) {
        if (cards.length > 1) return false;
        let c = cards[0];
        let isPickup = (c.displayValue === '2' || (c.displayValue === 'J' && ['♠','♣'].includes(c.displaySuit)));
        let isRedJ = (c.displayValue === 'J' && ['♥','♦'].includes(c.displaySuit));
        return (isPickup || isRedJ) ? [c] : false;
    }

    let allOrders = permute(cards);
    for (let order of allOrders) {
        let activeSuit = initialSuit;
        let activeVal = initialVal;
        let suitOverride = initialOverride;
        let sequenceIsValid = true;

        for (let i = 0; i < order.length; i++) {
            let card = order[i];
            if (isValidStep(card, activeVal, activeSuit, suitOverride, i === 0)) {
                activeVal = card.displayValue; activeSuit = card.displaySuit; suitOverride = null;
            } else {
                sequenceIsValid = false; break;
            }
        }
        if (sequenceIsValid) return order;
    }
    return false;
}

io.on('connection', (socket) => {
    
    socket.on('createRoom', ({ hostName, maxPlayers }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            maxPlayers: parseInt(maxPlayers),
            players: [{ id: socket.id, name: hostName, hand: [], saidCard: false, out: false, rank: null, color: '#ffeb3b', isHost: true, isAI: false }],
            deck: [],
            playedStack: [],
            activePickupCount: 0,
            currentPlayerIdx: 0,
            turnDirection: 1,
            activeSuitOverride: null,
            gameStarted: false,
            finishPodiumOrder: [],
            isGameOver: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', rooms[roomCode]);
    });

    socket.on('joinRoom', ({ name, roomCode }) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];
        if (!room) return socket.emit('errorMsg', 'Room not found!');
        if (room.gameStarted) return socket.emit('errorMsg', 'Game already started!');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'Room full!');

        const colors = ["#ffeb3b", "#00e5ff", "#ff4081", "#ff9100"];
        const playerColor = colors[room.players.length] || "#ffffff";

        room.players.push({ id: socket.id, name, hand: [], saidCard: false, out: false, rank: null, color: playerColor, isHost: false, isAI: false });
        socket.join(code);
        io.to(code).emit('roomUpdated', room);
        socket.emit('joinSuccess', { room, myId: socket.id });
    });

    socket.on('addBotServer', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players.length >= room.maxPlayers) return;

        const colors = ["#ffeb3b", "#00e5ff", "#ff4081", "#ff9100"];
        const botColor = colors[room.players.length] || "#ffffff";
        const botIndex = room.players.filter(p => p.isAI).length + 1;

        room.players.push({
            id: `bot-${Math.random().toString(36).substr(2, 5)}`,
            name: `CPU Bot ${botIndex}`,
            hand: [], saidCard: false, out: false, rank: null,
            color: botColor, isHost: false, isAI: true
        });

        io.to(roomCode).emit('roomUpdated', room);
    });

    socket.on('startGameServer', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.gameStarted) return;

        room.gameStarted = true;
        room.deck = createFreshDeck();
        shuffle(room.deck);

        room.players.forEach(p => {
            p.hand = [];
            for(let i=0; i<7; i++) p.hand.push(room.deck.pop());
        });

        let startCard = room.deck.pop();
        while(startCard.isJoker || ['A','2','8','J','Q','K'].includes(startCard.value)) {
            room.deck.unshift(startCard); shuffle(room.deck); startCard = room.deck.pop();
        }
        startCard.playedBy = "Dealer"; startCard.playerColor = "#aaaaaa";
        room.playedStack.push(startCard);

        // CLOUD DEVICE ROUTING FIX: Iterate through players and message individual sockets directly
        room.players.forEach(p => {
            if (!p.isAI && io.sockets.sockets.get(p.id)) {
                io.sockets.sockets.get(p.id).emit('gameStartedSignal', room);
            }
        });
        
        // Also send a fallback broadcast to ensure absolute synchronization
        io.to(roomCode).emit('gameStartedSignal', room);
        checkAndExecuteBotTurn(room);
    });

    socket.on('playCards', ({ roomCode, cardIndices, jokerConfigurations }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (!p || room.players[room.currentPlayerIdx].id !== socket.id) return;

        if (jokerConfigurations) {
            jokerConfigurations.forEach(conf => {
                if(p.hand[conf.index]) {
                    p.hand[conf.index].displayValue = conf.value;
                    p.hand[conf.index].displaySuit = conf.suit;
                    p.hand[conf.index].isJoker = true; 
                }
            });
        }

        let cardsToPlay = cardIndices.map(idx => p.hand[idx]);
        let workingOrderChain = getValidPermutation(cardsToPlay, room);
        if (!workingOrderChain) return socket.emit('errorMsg', 'Broken sequence link.');
        
        p.hand = p.hand.filter((_, idx) => !cardIndices.includes(idx));
        room.activeSuitOverride = null;

        executeChainActions(room, workingOrderChain, p);
    });

    socket.on('submitAceOverride', ({ roomCode, suit }) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.activeSuitOverride = suit;
        completeTurnPassing(room);
    });

    socket.on('drawOrPass', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.players[room.currentPlayerIdx].id !== socket.id) return;
        executeDrawAction(room, room.players[room.currentPlayerIdx]);
    });

    socket.on('sayCardDeclaration', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) { p.saidCard = true; io.to(roomCode).emit('gameStateSynced', room); }
    });

    socket.on('rearrangeHand', ({ roomCode, newHand }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) { p.hand = newHand; io.to(roomCode).emit('gameStateSynced', room); }
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            const room = rooms[code];
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0 || room.players.every(p => p.isAI)) delete rooms[code];
            else io.to(code).emit('gameStateSynced', room);
        }
    });
});

function executeChainActions(room, chain, player) {
    let lastPlayed = null;
    chain.forEach(card => {
        lastPlayed = card; lastPlayed.playedBy = player.name; lastPlayed.playerColor = player.color;
        room.playedStack.push(lastPlayed);

        let val = card.displayValue; let suit = card.displaySuit;
        if (val === '2') room.activePickupCount += 2;
        else if (val === 'J' && (suit === '♠' || suit === '♣')) room.activePickupCount += 4;
        else if (val === 'J' && (suit === '♥' || suit === '♦')) room.activePickupCount = 0;
        else if (val === '8') advanceTurn(room);
        else if (val === 'K' && room.players.length > 2) room.turnDirection *= -1;
    });

    if (player.hand.length === 0) {
        if (!player.saidCard) drawCards(room, player, 2);
        else { player.out = true; room.finishPodiumOrder.push(player.id); player.rank = room.finishPodiumOrder.length; }
    }

    if (lastPlayed.displayValue === 'A' && !player.isAI) {
        io.to(room.code).emit('promptAceSelectionNetwork', { room, playerId: player.id });
    } else if (lastPlayed.displayValue === 'A' && player.isAI) {
        let counts = { '♠':0, '♥':0, '♦':0, '♣':0 };
        player.hand.forEach(c => { if(counts[c.displaySuit] !== undefined) counts[c.displaySuit]++; });
        let best = '♠'; for(let s in counts) { if(counts[s] > counts[best]) best = s; }
        room.activeSuitOverride = best;
        completeTurnPassing(room);
    } else {
        completeTurnPassing(room);
    }
}

function executeDrawAction(room, player) {
    let count = room.activePickupCount > 0 ? room.activePickupCount : 1;
    drawCards(room, player, count);
    room.activePickupCount = 0; player.saidCard = false;
    completeTurnPassing(room);
}

function drawCards(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            if (room.playedStack.length <= 1) break;
            let top = room.playedStack.pop(); room.deck = [...room.playedStack];
            room.deck.forEach(c => { if(c.isJoker) { c.displayValue = '🃏'; c.displaySuit = '🃏'; } });
            shuffle(room.deck); room.playedStack = [top];
        }
        player.hand.push(room.deck.pop());
    }
}

function advanceTurn(room) {
    room.currentPlayerIdx = (room.currentPlayerIdx + room.turnDirection + room.players.length) % room.players.length;
}

function completeTurnPassing(room) {
    let activeCount = room.players.filter(pl => !pl.out).length;
    if (activeCount <= 1) {
        let lastPlayer = room.players.find(pl => !pl.out);
        if (lastPlayer) { room.finishPodiumOrder.push(lastPlayer.id); lastPlayer.rank = room.finishPodiumOrder.length; lastPlayer.out = true; }
        room.isGameOver = true; io.to(room.code).emit('gameStateSynced', room); return;
    }

    let currentTop = room.playedStack[room.playedStack.length - 1];
    if (currentTop && currentTop.displayValue === 'K' && activeCount === 2) {
        if (!room.players[room.currentPlayerIdx].out) { io.to(room.code).emit('gameStateSynced', room); checkAndExecuteBotTurn(room); return; }
    }

    advanceTurn(room);
    let loops = 0;
    while (loops < room.players.length) {
        let target = room.players[room.currentPlayerIdx];
        if (target.out && room.activePickupCount > 0) {
            target.out = false; target.rank = null;
            room.finishPodiumOrder = room.finishPodiumOrder.filter(id => id !== target.id);
            room.players.forEach(pl => { if(pl.out && pl.rank !== null) pl.rank = room.finishPodiumOrder.indexOf(pl.id) + 1; });
            drawCards(room, target, room.activePickupCount); room.activePickupCount = 0; target.saidCard = false; break;
        }
        if (!target.out) break;
        advanceTurn(room); loops++;
    }
    io.to(room.code).emit('gameStateSynced', room);
    checkAndExecuteBotTurn(room);
}

function checkAndExecuteBotTurn(room) {
    if (room.isGameOver) return;
    let currentMover = room.players[room.currentPlayerIdx];
    if (!currentMover || !currentMover.isAI || currentMover.out) return;

    setTimeout(() => {
        let currentTop = room.playedStack[room.playedStack.length - 1];
        let activeSuit = room.activeSuitOverride || currentTop.displaySuit;
        let activeVal = currentTop.displayValue;

        currentMover.hand.forEach(c => {
            if (c.isJoker) { c.displaySuit = activeSuit; c.displayValue = activeVal === 'Joker' ? '7' : activeVal; }
        });

        if (room.activePickupCount > 0) {
            let defenseIdx = currentMover.hand.findIndex(c => isPickupCard(c) || (c.displayValue === 'J' && ['♥','♦'].includes(c.displaySuit)));
            if (defenseIdx > -1) {
                let card = currentMover.hand[defenseIdx];
                if (currentMover.hand.length === 2) currentMover.saidCard = true;
                currentMover.hand.splice(defenseIdx, 1);
                executeChainActions(room, [card], currentMover);
            } else {
                executeDrawAction(room, currentMover);
            }
            return;
        }

        let workingSingleCard = null;
        for (let i = 0; i < currentMover.hand.length; i++) {
            let card = currentMover.hand[i];
            let order = getValidPermutation([card], room);
            if (order) { workingSingleCard = card; break; }
        }

        if (workingSingleCard) {
            if (currentMover.hand.length === 2) currentMover.saidCard = true;
            currentMover.hand = currentMover.hand.filter(c => c !== workingSingleCard);
            executeChainActions(room, [workingSingleCard], currentMover);
        } else {
            executeDrawAction(room, currentMover);
        }
    }, 3000); 
}

server.listen(PORT, '0.0.0.0', () => console.log(`Master Router active on port :${PORT}`));
