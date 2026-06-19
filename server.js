const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname)));

const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const botTimeouts = {};

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
            deck.push({ suit, value, isJoker: false, displayValue: value, displaySuit: suit, originalSuit: suit, playedBy: "System", playerColor: "#aaa" });
        }
    }
    deck.push({ suit: 'Joker', value: 'Joker', isJoker: true, displayValue: '🃏', displaySuit: '🃏', originalSuit: 'Joker', playedBy: "System", playerColor: "#aaa" });
    deck.push({ suit: 'Joker', value: 'Joker', isJoker: true, displayValue: '🃏', displaySuit: '🃏', originalSuit: 'Joker', playedBy: "System", playerColor: "#aaa" });
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
        if (remaining.length === 0) { res.push(current); return; }
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

function isValidConsecutiveStep(card, prevCard) {
    if (card.value === prevCard.value) return true;

    if (card.suit === prevCard.suit) {
        let idxA = VALUES.indexOf(prevCard.value);
        let idxB = VALUES.indexOf(card.value);
        if (Math.abs(idxA - idxB) === 1) return true;
    }
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
    if (room.playedStack.length === 0) return false;
    
    if (room.activePickupCount > 0 && cards.length > 1) {
        return false;
    }

    let currentTop = room.playedStack[room.playedStack.length - 1];
    let initialSuit = room.activeSuitOverride || currentTop.displaySuit;
    let initialVal = currentTop.displayValue;
    let initialOverride = room.activeSuitOverride;

    if (room.activePickupCount > 0) {
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
            
            if (i === 0) {
                if (!isValidStep(card, activeVal, activeSuit, suitOverride, true)) {
                    sequenceIsValid = false; break;
                }
            } else {
                let prevCard = order[i - 1];

                if (prevCard.displayValue === '2' && card.displayValue === 'A' && card.suit === prevCard.suit) {
                    // Valid step
                } 
                else if (prevCard.displayValue === 'A' && card.displayValue === '2' && card.suit === prevCard.suit) {
                    // Valid step
                }
                else if (!isValidConsecutiveStep(card, prevCard)) {
                    sequenceIsValid = false; 
                    break;
                }
            }
            
            activeVal = card.displayValue;
            activeSuit = card.displaySuit;
            suitOverride = null;
        }
        if (sequenceIsValid) return order;
    }
    return false;
}

function broadcastGameState(room) {
    room.players.forEach(p => {
        let localizedRoomState = JSON.parse(JSON.stringify(room));
        let isSafeSpectator = (p.out && !p.finishedOnPickup);

        localizedRoomState.players.forEach(pl => {
            if (pl.id !== p.id && !isSafeSpectator) {
                pl.hand = pl.hand.map(c => ({ isJoker: c.isJoker }));
            }
        });
        io.to(p.id).emit('gameStateSynced', localizedRoomState);
    });
}

io.on('connection', (socket) => {

    socket.on('attemptSessionRecovery', ({ token, roomCode }) => {
        if (!roomCode || !token) return;
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];
        if (!room) return;

        const p = room.players.find(pl => pl.sessionToken === token);
        if (p) {
            p.id = socket.id; 
            socket.join(code);
            socket.emit('sessionRecoverySuccess', { room, myId: socket.id });
            broadcastGameState(room);
        }
    });

    socket.on('createRoom', ({ hostName, maxPlayers, token }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            maxPlayers: parseInt(maxPlayers),
            players: [{ 
                id: socket.id, sessionToken: token, name: hostName, hand: [], 
                saidCard: false, out: false, rank: null, color: '#ffeb3b', 
                isHost: true, isAI: false, finishedOnPickup: false,
                scores: { first: 0, second: 0, third: 0, fourth: 0 }
            }],
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

    socket.on('joinRoom', ({ name, roomCode, token }) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];
        if (!room) return socket.emit('errorMsg', 'Room not found!');
        
        const existingPlayer = room.players.find(pl => pl.sessionToken === token);
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            socket.join(code);
            io.to(code).emit('roomUpdated', room);
            socket.emit('joinSuccess', { room, myId: socket.id });
            return broadcastGameState(room);
        }

        if (room.gameStarted) return socket.emit('errorMsg', 'Game already started!');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'Room full!');

        const colors = ["#ffeb3b", "#00e5ff", "#ff4081", "#ff9100"];
        const playerColor = colors[room.players.length] || "#ffffff";

        room.players.push({ 
            id: socket.id, sessionToken: token, name, hand: [], 
            saidCard: false, out: false, rank: null, color: playerColor, 
            isHost: false, isAI: false, finishedOnPickup: false,
            scores: { first: 0, second: 0, third: 0, fourth: 0 }
        });
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
            sessionToken: `bot-tok-${Math.random()}`,
            name: `CPU Bot ${botIndex}`,
            hand: [], saidCard: false, out: false, rank: null, color: botColor, isHost: false, isAI: true, finishedOnPickup: false,
            scores: { first: 0, second: 0, third: 0, fourth: 0 }
        });
        io.to(roomCode).emit('roomUpdated', room);
    });

    socket.on('startGameServer', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.gameStarted) return;
        initializeRound(room);
    });

    socket.on('requestRematchServer', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || !room.isGameOver) return;
        initializeRound(room);
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
                    p.hand[conf.index].suit = conf.suit;
                    p.hand[conf.index].value = conf.value;
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

        if (room.playedStack.length > 0) {
            let topCard = room.playedStack[room.playedStack.length - 1];
            if (topCard.displayValue === 'A') {
                topCard.displaySuit = suit; 
                topCard.suitOverrideActive = true; 
            }
        }

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
        if (p) { p.saidCard = true; broadcastGameState(room); }
    });

    socket.on('rearrangeHand', ({ roomCode, newHand }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) { p.hand = newHand; broadcastGameState(room); }
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            const room = rooms[code];
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) {
                if (!room.gameStarted) {
                    room.players = room.players.filter(pl => pl.id !== socket.id);
                    if (room.players.length === 0 || room.players.every(pl => pl.isAI)) delete rooms[code];
                    else io.to(code).emit('roomUpdated', room);
                } else {
                    broadcastGameState(room);
                }
            }
        }
    });
});

function initializeRound(room) {
    room.gameStarted = true;
    room.isGameOver = false;
    room.deck = createFreshDeck();
    shuffle(room.deck);
    room.finishPodiumOrder = [];
    room.activePickupCount = 0;
    room.currentPlayerIdx = 0;
    room.turnDirection = 1;
    room.activeSuitOverride = null;

    room.players.forEach(p => {
        p.hand = []; p.saidCard = false; p.out = false; p.rank = null; p.finishedOnPickup = false;
        for(let i=0; i<7; i++) p.hand.push(room.deck.pop());
    });

    let startCard = room.deck.pop();
    while(startCard.isJoker || ['A','2','8','J','Q','K'].includes(startCard.value)) {
        room.deck.unshift(startCard); shuffle(room.deck); startCard = room.deck.pop();
    }
    startCard.playedBy = "Dealer"; startCard.playerColor = "#aaaaaa";
    room.playedStack = [startCard];

    io.to(room.code).emit('gameStartedSignal', room);
    broadcastGameState(room);
    checkAndExecuteBotTurn(room);
}

function executeChainActions(room, chain, player) {
    let lastPlayed = null;
    let neutralizedAceIndices = [];

    for (let i = 0; i < chain.length; i++) {
        let card = chain[i];
        if (card.displayValue === '2' && i + 1 < chain.length && chain[i + 1].displayValue === 'A' && chain[i + 1].suit === card.suit) {
            neutralizedAceIndices.push(i + 1);
        }
    }

    chain.forEach((card, i) => {
        lastPlayed = card; 
        lastPlayed.playedBy = player.name; 
        lastPlayed.playerColor = player.color;
        room.playedStack.push(lastPlayed);
    });

    let topVal = lastPlayed.displayValue;
    let topSuit = lastPlayed.displaySuit;

    if (topVal === '2') {
        let lastCardWasNeutralized = neutralizedAceIndices.includes(chain.length - 1);
        if (!lastCardWasNeutralized) {
            room.activePickupCount += 2;
        }
    }
    else if (topVal === 'J' && (topSuit === '♠' || topSuit === '♣')) room.activePickupCount += 4;
    else if (topVal === 'J' && (topSuit === '♥' || topSuit === '♦')) room.activePickupCount = 0;
    else if (topVal === '8') advanceTurn(room);
    else if (topVal === 'K' && room.players.length > 2) room.turnDirection *= -1;

    if (player.hand.length === 0) {
        if (!player.saidCard) {
            drawCards(room, player, 2);
        } else {
            player.out = true;
            room.finishPodiumOrder.push(player.id);
            player.rank = room.finishPodiumOrder.length;
            
            if (player.rank === 1) player.scores.first++;
            else if (player.rank === 2) player.scores.second++;
            else if (player.rank === 3) player.scores.third++;
            else if (player.rank === 4) player.scores.fourth++;

            if (lastPlayed && (lastPlayed.displayValue === '2' || (lastPlayed.displayValue === 'J' && ['♠','♣'].includes(lastPlayed.displaySuit)))) {
                player.finishedOnPickup = true;
            } else {
                player.finishedOnPickup = false;
            }
        }
    }

    let lastCardWasAce = (topVal === 'A');
    let lastCardWasNeutralized = neutralizedAceIndices.includes(chain.length - 1);

    if (lastCardWasAce && !lastCardWasNeutralized && !player.isAI) {
        io.to(room.code).emit('promptAceSelectionNetwork', { room, playerId: player.id });
    } else if (lastCardWasAce && !lastCardWasNeutralized && player.isAI) {
        let counts = { '♠':0, '♥':0, '♦':0, '♣':0 };
        player.hand.forEach(c => { if(counts[c.displaySuit] !== undefined) counts[c.displaySuit]++; });
        let best = '♠'; for(let s in counts) { if(counts[s] > counts[best]) best = s; }
        
        if (room.playedStack.length > 0) {
            let topCard = room.playedStack[room.playedStack.length - 1];
            if (topCard.displayValue === 'A') {
                topCard.displaySuit = best;
                topCard.suitOverrideActive = true;
            }
        }

        room.activeSuitOverride = best;
        completeTurnPassing(room);
    } else {
        completeTurnPassing(room);
    }
}

function executeDrawAction(room, player) {
    let count = room.activePickupCount > 0 ? room.activePickupCount : 1;
    drawCards(room, player, count);
    
    if (room.activePickupCount > 0) {
        room.players.forEach(p => p.finishedOnPickup = false);
    }

    room.activePickupCount = 0; 
    player.saidCard = false;
    completeTurnPassing(room);
}

function drawCards(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            if (room.playedStack.length <= 1) {
                let freshDeckFallback = createFreshDeck();
                shuffle(freshDeckFallback);
                room.deck = freshDeckFallback;
            } else {
                let top = room.playedStack.pop(); 
                room.deck = [...room.playedStack];
                room.deck.forEach(c => { 
                    if(c.isJoker) { 
                        c.displayValue = '🃏'; 
                        c.displaySuit = '🃏'; 
                        c.suit = 'Joker';
                        c.value = 'Joker';
                    } 
                    c.suitOverrideActive = false; 
                });
                shuffle(room.deck); 
                room.playedStack = [top];
            }
        }
        let drawnCard = room.deck.pop();
        if (drawnCard) player.hand.push(drawnCard);
    }
}

function advanceTurn(room) {
    room.currentPlayerIdx = (room.currentPlayerIdx + room.turnDirection + room.players.length) % room.players.length;
}

function completeTurnPassing(room) {
    let activeCount = room.players.filter(pl => !pl.out).length;
    
    if (activeCount <= 1) {
        let lastPlayer = room.players.find(pl => !pl.out);
        if (lastPlayer) { 
            room.finishPodiumOrder.push(lastPlayer.id); 
            lastPlayer.rank = room.finishPodiumOrder.length; 
            lastPlayer.out = true; 
            
            if (lastPlayer.rank === 1) lastPlayer.scores.first++;
            else if (lastPlayer.rank === 2) lastPlayer.scores.second++;
            else if (lastPlayer.rank === 3) lastPlayer.scores.third++;
            else if (lastPlayer.rank === 4) lastPlayer.scores.fourth++;
        }
        room.isGameOver = true; 
        broadcastGameState(room); 
        return;
    }

    let currentTop = room.playedStack[room.playedStack.length - 1];
    if (currentTop && currentTop.displayValue === 'K' && activeCount === 2) {
        if (!room.players[room.currentPlayerIdx].out) { broadcastGameState(room); checkAndExecuteBotTurn(room); return; }
    }

    advanceTurn(room);
    let loops = 0;
    while (loops < room.players.length) {
        let target = room.players[room.currentPlayerIdx];
        
        if (target.out) {
            if (room.activePickupCount > 0 && target.finishedOnPickup === true) {
                target.out = false; 
                
                if (target.rank === 1) target.scores.first--;
                else if (target.rank === 2) target.scores.second--;
                else if (target.rank === 3) target.scores.third--;
                else if (target.rank === 4) target.scores.fourth--;

                target.rank = null;
                target.finishedOnPickup = false;
                
                room.finishPodiumOrder = room.finishPodiumOrder.filter(id => id !== target.id);
                room.players.forEach(pl => { if(pl.out && pl.rank !== null) pl.rank = room.finishPodiumOrder.indexOf(pl.id) + 1; });
                
                drawCards(room, target, room.activePickupCount); 
                room.activePickupCount = 0; 
                target.saidCard = false; 
                break;
            }
        }

        if (!target.out) break;
        advanceTurn(room); loops++;
    }
    broadcastGameState(room);
    checkAndExecuteBotTurn(room);
}

function checkAndExecuteBotTurn(room) {
    if (room.isGameOver) return;
    let currentMover = room.players[room.currentPlayerIdx];
    if (!currentMover || !currentMover.isAI || currentMover.out) return;

    const roomCode = room.code;
    
    if (botTimeouts[roomCode]) {
        clearTimeout(botTimeouts[roomCode]);
        botTimeouts[roomCode] = null;
    }

    const shiftingBotIdentityId = currentMover.id;

    botTimeouts[roomCode] = setTimeout(() => {
        if (room.isGameOver) return;
        if (room.players[room.currentPlayerIdx].id !== shiftingBotIdentityId) return;

        let currentTop = room.playedStack[room.playedStack.length - 1];
        let activeSuit = room.activeSuitOverride || currentTop.displaySuit;
        let activeVal = currentTop.displayValue;

        // --- 1. DEFENSIVE ATTACK ROUTINE ---
        if (room.activePickupCount > 0) {
            let defenseIdx = currentMover.hand.findIndex(c => {
                if (c.isJoker) return true;
                return isPickupCard(c) || (c.displayValue === 'J' && ['♥','♦'].includes(c.displaySuit));
            });

            if (defenseIdx > -1) {
                let card = currentMover.hand[defenseIdx];
                if (card.isJoker) {
                    card.displaySuit = activeSuit;
                    card.displayValue = activeVal === 'Joker' ? '7' : activeVal;
                }
                if (currentMover.hand.length === 2) currentMover.saidCard = true;
                
                currentMover.hand.splice(defenseIdx, 1);
                room.activeSuitOverride = null;
                executeChainActions(room, [card], currentMover);
            } else {
                executeDrawAction(room, currentMover);
            }
            return;
        }

        // --- 2. STRICT SINGLE-CARD VALIDATION DEPLOYMENT ---
        let playCardIdx = currentMover.hand.findIndex(c => {
            let cardCopy = { ...c };
            if (cardCopy.isJoker) {
                cardCopy.displaySuit = activeSuit;
                cardCopy.displayValue = activeVal === 'Joker' ? '7' : activeVal;
            }
            return isValidStep(cardCopy, activeVal, activeSuit, room.activeSuitOverride, true);
        });

        if (playCardIdx > -1) {
            let card = currentMover.hand[playCardIdx];
            
            // Declare card if hand is emptying next step
            if (currentMover.hand.length === 2) {
                currentMover.saidCard = true;
            }

            if (card.isJoker) {
                card.displaySuit = activeSuit;
                card.displayValue = activeVal === 'Joker' ? '7' : activeVal;
                card.suit = activeSuit;
                card.value = card.displayValue;
            }

            currentMover.hand.splice(playCardIdx, 1);
            room.activeSuitOverride = null;
            executeChainActions(room, [card], currentMover);
        } else {
            executeDrawAction(room, currentMover);
        }
    }, 3000); 
}

server.listen(PORT, '0.0.0.0', () => console.log(`Master Router active on port :${PORT}`));
