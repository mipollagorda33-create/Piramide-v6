const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const PALOS = ['Oros', 'Copas', 'Espadas', 'Bastos'];
const VALORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 48 cartas españolas

const EVENTOS_CEFA = [
    "👁️ LEY DE CEFA: Prohibido decir 'beber', 'trago' o 'copa'. Quien lo diga bebe 2.",
    "👁️ LEY DE CEFA: Todos beben con la mano izquierda hasta el próximo evento.",
    "👁️ LEY DE CEFA: Prohibido señalar con el dedo. Si señalas, bebes 2.",
    "👁️ LEY DE CEFA: El último en levantar la mano cada vez que el Máster diga 'CEFA' bebe 3.",
    "👁️ EVENTO RELÁMPAGO: ¡Cascada general! Empieza el Máster y seguís en orden de lista.",
    "👁️ LEY DE CEFA: Prohibido decir nombres propios. Usad apodos o bebéis 2.",
    "👁️ EVENTO RELÁMPAGO: Todos los que tengan cartas de OROS en su mano beben 2 tragos.",
    "👁️ EVENTO RELÁMPAGO: Todos los que tengan cartas de ESPADAS mandan 2 tragos.",
    "👁️ LEY DE CEFA: Nadie puede mirar a los ojos al Máster. Quien cruce mirada bebe 2.",
    "👁️ EVENTO RELÁMPAGO: ¡Brindis obligatorio! Todos beben 2 tragos ahora mismo.",
    "👁️ LEY DE CEFA: Prohibido apoyar los codos en la mesa. Quien los apoye bebe 2.",
    "👁️ EVENTO RELÁMPAGO: El jugador con menos tragos acumulados se bebe 3 ahora mismo."
];

function nombreCarta(num) {
    if (num === 1) return 'As';
    if (num === 10) return 'Sota';
    if (num === 11) return 'Caballo';
    if (num === 12) return 'Rey';
    return String(num);
}

function generarBarajaEspanola() {
    let deck = [];
    for (let palo of PALOS) {
        for (let num of VALORES) {
            deck.push({
                id: Math.random().toString(36).substring(2, 10),
                num,
                label: nombreCarta(num),
                palo
            });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function addLog(roomCode, text) {
    const room = rooms[roomCode];
    if (!room) return;
    const entry = {
        time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        text
    };
    room.logs.unshift(entry);
    if (room.logs.length > 30) room.logs.pop();
    io.to(roomCode).emit('updateLogs', room.logs);
}

function emitRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const activePlayer = room.players[room.turnPlayerIndex] || null;
    io.to(roomCode).emit('stateSync', {
        state: room.state,
        phase1Round: room.phase1Round,
        activePlayerId: activePlayer ? activePlayer.id : null,
        activePlayerName: activePlayer ? activePlayer.name : null,
        pyramid: room.pyramid,
        currentRow: room.currentRow,
        auction: room.auction ? {
            active: room.auction.active,
            card: room.auction.card,
            bid: room.auction.bid,
            leaderId: room.auction.leaderId,
            leaderName: room.auction.leaderName,
            secondsLeft: room.auction.secondsLeft,
            isOvertime: room.auction.isOvertime
        } : null,
        activeRule: room.activeRule
    });
}

function broadcastPlayers(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('updatePlayers', room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        drinks: p.drinks,
        ghost: p.ghost,
        cardCount: p.hand.length
    })));
}

function advancePhase1Turn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Buscar siguiente jugador no fantasma, o avanzar ronda
    let attempts = 0;
    const total = room.players.length;
    while (attempts < total) {
        room.turnPlayerIndex++;
        if (room.turnPlayerIndex >= total) {
            room.turnPlayerIndex = 0;
            room.phase1Round++;
        }
        if (room.phase1Round > 4) break;
        if (!room.players[room.turnPlayerIndex].ghost) break;
        attempts++;
    }

    if (room.phase1Round > 4) {
        // Montar Pirámide de 4 filas (10 cartas: índices 0..9, fila 1 = base 4 cartas, fila 4 = cima 1 carta)
        room.pyramid = [];
        for (let i = 0; i < 10; i++) {
            const c = room.deck.pop();
            c.revealed = false;
            room.pyramid.push(c);
        }
        room.currentRow = 1; // Fila 1 (base de 4), 2 (3), 3 (2), 4 (cima 1)
        room.state = 'PIRAMIDE_FILA';
        io.to(roomCode).emit('phaseTransition', '¡FASE 1 COMPLETADA! Comienza La Pirámide');
        addLog(roomCode, '🔥 Comienza La Pirámide (Fila 1 - Base)');
    }
    emitRoomState(roomCode);
}

function finalizeAuction(roomCode) {
    const room = rooms[roomCode];
    if (!room || !room.auction) return;
    clearInterval(room.auction.timer);

    const { card, bid, leaderId, leaderName } = room.auction;
    if (leaderId) {
        const winner = room.players.find(p => p.id === leaderId);
        if (winner) {
            winner.drinks += bid;
            winner.hand.push(card);
            io.to(winner.id).emit('updateHand', winner.hand);
            broadcastPlayers(roomCode);
            addLog(roomCode, `🔨 ${leaderName} ganó el ${card.label} de ${card.palo} por ${bid} tragos.`);
            io.to(roomCode).emit('serverMsg', `🔨 ¡${leaderName} gana la subasta (${bid} tragos) y se lleva el ${card.label} de ${card.palo}!`);
        }
    } else {
        addLog(roomCode, `🔨 Subasta desierta: nadie pujó por el ${card.label} de ${card.palo}.`);
        io.to(roomCode).emit('serverMsg', '🔨 Nadie pujó. La carta se descarta.');
    }

    room.auction = null;
    room.state = 'POST_SUBASTA'; // Listo para que el Máster destape el Evento de esta fila
    emitRoomState(roomCode);
}

io.on('connection', (socket) => {
    socket.on('heartbeat', () => {
        socket.emit('heartbeatAck');
    });

    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!username || !roomCode) return;
        const cleanUser = username.trim();
        const cleanRoom = roomCode.toUpperCase().trim();

        if (!rooms[cleanRoom]) {
            rooms[cleanRoom] = {
                host: socket.id,
                players: [],
                deck: [],
                state: 'LOBBY',
                phase1Round: 1,
                turnPlayerIndex: 0,
                pyramid: [],
                currentRow: 1,
                auction: null,
                activeRule: 'Ninguna norma activa todavía',
                activeChallenges: {},
                logs: []
            };
        }

        const room = rooms[cleanRoom];
        const isDuplicate = room.players.some(p => p.name.toLowerCase() === cleanUser.toLowerCase());
        if (isDuplicate) {
            socket.emit('errorMsg', 'Ese apodo ya está en uso en esta sala. Elige otro.');
            return;
        }

        socket.join(cleanRoom);
        const isHost = room.players.length === 0;
        if (isHost) room.host = socket.id;

        const player = {
            id: socket.id,
            name: cleanUser,
            isHost,
            drinks: 0,
            ghost: false,
            hand: []
        };
        room.players.push(player);

        socket.emit('joined', { roomCode: cleanRoom, player, isHost });
        broadcastPlayers(cleanRoom);
        socket.emit('updateLogs', room.logs);
        emitRoomState(cleanRoom);
        if (room.state !== 'LOBBY') {
            socket.emit('updateHand', player.hand);
        }
    });

    // Modo Fantasma / AFK manual
    socket.on('toggleGhost', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        player.ghost = !player.ghost;
        broadcastPlayers(roomCode);
        addLog(roomCode, player.ghost ? `👻 ${player.name} activó el Modo Fantasma.` : `⚡ ${player.name} volvió a la mesa.`);

        // Si era su turno en Fase 1 y se puso fantasma, avanzar turno para no bloquear
        if (room.state === 'FASE_1' && room.players[room.turnPlayerIndex]?.id === socket.id && player.ghost) {
            advancePhase1Turn(roomCode);
        }
    });

    // MASTER: Iniciar Fase 1
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.host !== socket.id) return;

        room.deck = generarBarajaEspanola();
        room.players.forEach(p => {
            p.hand = [];
            p.drinks = 0;
            io.to(p.id).emit('updateHand', []);
        });
        room.state = 'FASE_1';
        room.phase1Round = 1;
        room.turnPlayerIndex = 0;
        room.activeRule = 'Ninguna norma activa todavía';

        // Si el primero está en fantasma, buscar activo
        if (room.players[0]?.ghost) {
            advancePhase1Turn(roomCode);
        } else {
            broadcastPlayers(roomCode);
            emitRoomState(roomCode);
        }
        addLog(roomCode, '🎲 ¡Comienza la Fase 1! Reparto carta a carta.');
    });

    // JUGADOR: Responder pregunta de Fase 1
    socket.on('answerPhase1', ({ roomCode, answer, targetId }) => {
        const room = rooms[roomCode];
        if (!room || room.state !== 'FASE_1') return;

        const player = room.players[room.turnPlayerIndex];
        if (!player || player.id !== socket.id) return;

        if (room.deck.length === 0) room.deck = generarBarajaEspanola();
        const card = room.deck.pop();
        const round = room.phase1Round;

        let success = false;
        let resultText = '';
        let pendingTargetSend = 0;

        if (round === 1) {
            // Palo
            success = (card.palo === answer);
            if (success) {
                resultText = `✅ ${player.name} acertó ${card.palo} (${card.label} de ${card.palo}) y manda 1 trago.`;
            } else {
                player.drinks += 1;
                resultText = `❌ ${player.name} dijo ${answer} y salió ${card.label} de ${card.palo}. Bebe 1 trago.`;
            }
        } else if (round === 2) {
            // Mayor, Menor o Igual respecto a carta 1
            const c1 = player.hand[0].num;
            if (answer === 'Mayor') success = card.num > c1;
            if (answer === 'Menor') success = card.num < c1;
            if (answer === 'Igual') success = card.num === c1;

            if (success) {
                resultText = `✅ ${player.name} acertó (${answer} que ${nombreCarta(c1)}) con ${card.label} de ${card.palo} y manda 2 tragos.`;
            } else {
                player.drinks += 2;
                resultText = `❌ ${player.name} falló (${answer} que ${nombreCarta(c1)}), salió ${card.label} de ${card.palo}. Bebe 2 tragos.`;
            }
        } else if (round === 3) {
            // Dentro, Igual o Fuera respecto a cartas 1 y 2
            const min = Math.min(player.hand[0].num, player.hand[1].num);
            const max = Math.max(player.hand[0].num, player.hand[1].num);
            if (answer === 'Dentro') success = (card.num > min && card.num < max);
            if (answer === 'Fuera') success = (card.num < min || card.num > max);
            if (answer === 'Igual') success = (card.num === min || card.num === max);

            if (success) {
                resultText = `✅ ${player.name} acertó (${answer}) con ${card.label} de ${card.palo} y manda 3 tragos.`;
            } else {
                player.drinks += 3;
                resultText = `❌ ${player.name} falló (${answer}), salió ${card.label} de ${card.palo}. Bebe 3 tragos.`;
            }
        } else if (round === 4) {
            // Apostar número exacto (1-12)
            const guess = parseInt(answer, 10);
            if (guess === card.num) {
                success = true;
                pendingTargetSend = card.num;
                resultText = `🎯 ¡CLAVADA DE ${player.name}! Acertó el ${card.label} de ${card.palo} y manda ${card.num} tragos.`;
            } else {
                const diff = Math.abs(guess - card.num); // Siempre positiva
                player.drinks += diff;
                resultText = `💥 ${player.name} apostó al ${nombreCarta(guess)} y salió ${card.label} de ${card.palo}. Bebe ${diff} tragos.`;
            }
        }

        // Si acertó en rondas 1-3 o ronda 4 y eligió víctima
        if (success && targetId) {
            const target = room.players.find(p => p.id === targetId);
            const amount = round === 4 ? pendingTargetSend : round;
            if (target) {
                target.drinks += amount;
                resultText += ` (Víctima: ${target.name})`;
            }
        }

        player.hand.push(card);
        io.to(player.id).emit('updateHand', player.hand);
        io.to(player.id).emit('phase1CardDrawn', { card, success, resultText });
        io.to(roomCode).emit('serverMsg', resultText);
        addLog(roomCode, resultText);
        broadcastPlayers(roomCode);

        advancePhase1Turn(roomCode);
    });

    // MASTER: Destapar siguiente carta de la fila actual
    socket.on('revealNextCard', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.host !== socket.id || room.state !== 'PIRAMIDE_FILA') return;

        // Mapeo de índices de la pirámide por fila:
        // Fila 1 (Base, 4 cartas): índices 0, 1, 2, 3
        // Fila 2 (3 cartas): índices 4, 5, 6
        // Fila 3 (2 cartas): índices 7, 8
        // Fila 4 (Cima, 1 carta): índice 9
        const rowIndices = {
            1: [0, 1, 2, 3],
            2: [4, 5, 6],
            3: [7, 8],
            4: [9]
        }[room.currentRow];

        const nextIdx = rowIndices.find(idx => !room.pyramid[idx].revealed);
        if (nextIdx !== undefined) {
            const card = room.pyramid[nextIdx];
            card.revealed = true;
            addLog(roomCode, `🃏 Fila ${room.currentRow}: Destapado ${card.label} de ${card.palo} (Valen ${room.currentRow} tragos).`);
            io.to(roomCode).emit('cardRevealed', { card, row: room.currentRow });

            // Comprobar si era la última carta de esta fila
            const stillHidden = rowIndices.some(idx => !room.pyramid[idx].revealed);
            if (!stillHidden) {
                room.state = 'LISTO_SUBASTA';
            }
            emitRoomState(roomCode);
        }
    });

    // MASTER: Abrir Subasta al terminar la fila
    socket.on('startAuction', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.host !== socket.id || room.state !== 'LISTO_SUBASTA') return;

        if (room.deck.length === 0) room.deck = generarBarajaEspanola();
        const auctionCard = room.deck.pop();

        room.state = 'SUBASTA';
        room.auction = {
            active: true,
            card: auctionCard,
            bid: 1,
            leaderId: null,
            leaderName: 'Nadie todavía',
            secondsLeft: 15,
            isOvertime: false,
            timer: null
        };

        addLog(roomCode, `🔨 ¡Subasta abierta por un ${auctionCard.label} de ${auctionCard.palo}!`);
        emitRoomState(roomCode);

        room.auction.timer = setInterval(() => {
            if (!room.auction) return;
            room.auction.secondsLeft--;

            if (room.auction.secondsLeft <= 0) {
                if (!room.auction.isOvertime && room.auction.leaderId) {
                    // Terminan los 15s iniciales y hay pujador -> entra prórroga de 5s
                    room.auction.isOvertime = true;
                    room.auction.secondsLeft = 5;
                    io.to(roomCode).emit('auctionOvertime');
                } else {
                    finalizeAuction(roomCode);
                    return;
                }
            }
            emitRoomState(roomCode);
        }, 1000);
    });

    // JUGADOR: Pujar en Subasta (+1, +3, +5)
    socket.on('placeBid', ({ roomCode, increment }) => {
        const room = rooms[roomCode];
        if (!room || room.state !== 'SUBASTA' || !room.auction || !room.auction.active) return;

        const inc = parseInt(increment, 10);
        if (![1, 3, 5].includes(inc)) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.ghost) return;

        // Primera puja desde base 1 o suma sobre la actual
        if (!room.auction.leaderId && inc === 1) {
            room.auction.bid = 1;
        } else {
            room.auction.bid += inc;
        }
        room.auction.leaderId = player.id;
        room.auction.leaderName = player.name;

        // Después de los 15s iniciales (en prórroga), cada puja reinicia el contador a 5s
        if (room.auction.isOvertime) {
            room.auction.secondsLeft = 5;
            io.to(roomCode).emit('auctionOvertime');
        }

        emitRoomState(roomCode);
    });

    // MASTER: Destapar Evento tras la Subasta
    socket.on('revealEvent', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.host !== socket.id || room.state !== 'POST_SUBASTA') return;

        const eventText = EVENTOS_CEFA[Math.floor(Math.random() * EVENTOS_CEFA.length)];
        room.activeRule = eventText;
        addLog(roomCode, eventText);
        io.to(roomCode).emit('eventRevealed', eventText);

        // Si el evento es el de "el jugador con menos tragos bebe 3"
        if (eventText.includes('menos tragos acumulados')) {
            const activePlayers = room.players.filter(p => !p.ghost);
            if (activePlayers.length > 0) {
                activePlayers.sort((a, b) => a.drinks - b.drinks);
                activePlayers[0].drinks += 3;
                broadcastPlayers(roomCode);
                addLog(roomCode, `🍺 ${activePlayers[0].name} era el más sobrio y bebe 3 tragos.`);
            }
        }

        if (room.currentRow < 4) {
            room.currentRow++;
            room.state = 'PIRAMIDE_FILA';
            addLog(roomCode, `⬆️ Pasamos a la Fila ${room.currentRow} de la Pirámide.`);
        } else {
            // Fin de la Pirámide -> Hall of Fame
            room.state = 'HALL_OF_FAME';
            const sorted = [...room.players].sort((a, b) => b.drinks - a.drinks);
            const sober = sorted[sorted.length - 1];
            if (sober) {
                sober.drinks += 5; // Castigo de 5 tragos al más sobrio
                broadcastPlayers(roomCode);
            }
            const finalRanking = [...room.players].sort((a, b) => b.drinks - a.drinks);
            io.to(roomCode).emit('gameFinished', {
                ranking: finalRanking,
                soberName: sober ? sober.name : 'Nadie'
            });
            addLog(roomCode, '🏆 ¡FIN DE LA PARTIDA! Hall of Fame desplegado.');
        }

        emitRoomState(roomCode);
    });

    // JUGADOR: Mandar carta de su inventario a otro (la carta viaja, no desaparece)
    socket.on('sendCard', ({ roomCode, cardId, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const sender = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);
        if (!sender || !target || sender.id === target.id) return;

        const cardIdx = sender.hand.findIndex(c => c.id === cardId);
        if (cardIdx === -1) return;

        const [card] = sender.hand.splice(cardIdx, 1);
        target.hand.push(card);

        // Si estamos en la pirámide y el número coincide con alguna carta destapada de la fila actual, suma tragos de la fila
        let drinksSent = 0;
        if (room.state === 'PIRAMIDE_FILA' || room.state === 'LISTO_SUBASTA') {
            const rowIndices = { 1: [0, 1, 2, 3], 2: [4, 5, 6], 3: [7, 8], 4: [9] }[room.currentRow];
            const matchesRow = rowIndices.some(idx => room.pyramid[idx].revealed && room.pyramid[idx].num === card.num);
            if (matchesRow) {
                drinksSent = room.currentRow;
                target.drinks += drinksSent;
            }
        }

        io.to(sender.id).emit('updateHand', sender.hand);
        io.to(target.id).emit('updateHand', target.hand);
        broadcastPlayers(roomCode);

        const msg = drinksSent > 0
            ? `🃏 ${sender.name} lanzó ${card.label} de ${card.palo} a ${target.name} (+${drinksSent} tragos).`
            : `🃏 ${sender.name} pasó ${card.label} de ${card.palo} al inventario de ${target.name}.`;

        io.to(roomCode).emit('cardTransferred', { from: sender.name, to: target.name, card, drinksSent });
        addLog(roomCode, msg);
    });

    // ==========================================
    // MINIJUEGOS DE PAUSA (COINFLIP & PPT)
    // ==========================================
    socket.on('sendChallenge', ({ roomCode, targetId, gameType }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Bloqueo: ni el retador ni el retado pueden tener otro reto activo
        const busy = Object.values(room.activeChallenges).some(
            c => c.challenger === socket.id || c.target === socket.id || c.challenger === targetId || c.target === targetId
        );
        if (busy) {
            socket.emit('errorMsg', 'Ya hay un reto activo entre vosotros o con ese jugador.');
            return;
        }

        const challenger = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);
        if (!challenger || !target) return;

        const challengeId = Math.random().toString(36).substring(2, 10);
        room.activeChallenges[challengeId] = {
            id: challengeId,
            challenger: socket.id,
            challengerName: challenger.name,
            target: targetId,
            targetName: target.name,
            gameType,
            status: 'pending'
        };

        socket.emit('challengeWaiting', { challengeId, targetName: target.name });
        io.to(targetId).emit('incomingChallenge', {
            challengeId,
            challengerName: challenger.name,
            gameType
        });

        setTimeout(() => {
            if (room.activeChallenges[challengeId] && room.activeChallenges[challengeId].status === 'pending') {
                delete room.activeChallenges[challengeId];
                io.to(socket.id).emit('challengeClosed', 'El reto caducó tras 15 segundos sin respuesta.');
                io.to(targetId).emit('challengeClosed', 'El reto ha caducado.');
            }
        }, 15000);
    });

    socket.on('acceptChallenge', ({ roomCode, challengeId }) => {
        const room = rooms[roomCode];
        const c = room?.activeChallenges[challengeId];
        if (!c || c.status !== 'pending') return;

        c.status = 'accepted';
        io.to(c.challenger).emit('challengeAccepted', c);
        io.to(c.target).emit('challengeAccepted', c);
    });

    socket.on('rejectChallenge', ({ roomCode, challengeId }) => {
        const room = rooms[roomCode];
        const c = room?.activeChallenges[challengeId];
        if (!c) return;

        delete room.activeChallenges[challengeId];
        io.to(c.challenger).emit('challengeClosed', `${c.targetName} rechazó el reto.`);
        io.to(c.target).emit('challengeClosed', 'Has rechazado el reto.');
    });

    socket.on('coinflipChoice', ({ roomCode, challengeId, choice }) => {
        const room = rooms[roomCode];
        const c = room?.activeChallenges[challengeId];
        if (!c || c.status !== 'accepted' || c.locked) return;
        c.locked = true;

        const challengerSide = choice === 'Cara' ? 'Cruz' : 'Cara';
        io.to(c.challenger).emit('playCoinAnimation', { yourSide: challengerSide, rivalSide: choice });
        io.to(c.target).emit('playCoinAnimation', { yourSide: choice, rivalSide: challengerSide });

        setTimeout(() => {
            const result = Math.random() > 0.5 ? 'Cara' : 'Cruz';
            const targetWon = (result === choice);
            const winnerId = targetWon ? c.target : c.challenger;
            const loserId = targetWon ? c.challenger : c.target;

            const winner = room.players.find(p => p.id === winnerId);
            const loser = room.players.find(p => p.id === loserId);
            if (loser) loser.drinks += 2;

            broadcastPlayers(roomCode);
            const payload = {
                game: 'Coinflip de la Muerte',
                resultStr: `Salió ${result} (${c.targetName}: ${choice} | ${c.challengerName}: ${challengerSide})`,
                winner: winner ? winner.name : 'Nadie',
                loser: loser ? loser.name : 'Nadie',
                penalty: 2
            };
            io.to(c.challenger).emit('minigameResult', payload);
            io.to(c.target).emit('minigameResult', payload);
            addLog(roomCode, `🪙 Coinflip: ${payload.winner} ganó a ${payload.loser} (+2 tragos).`);
            delete room.activeChallenges[challengeId];
        }, 3000);
    });

    socket.on('rpsChoice', ({ roomCode, challengeId, choice }) => {
        const room = rooms[roomCode];
        const c = room?.activeChallenges[challengeId];
        if (!c || c.status !== 'accepted') return;

        if (socket.id === c.challenger && !c.challengerChoice) c.challengerChoice = choice;
        if (socket.id === c.target && !c.targetChoice) c.targetChoice = choice;

        if (c.challengerChoice && c.targetChoice) {
            const ch = c.challengerChoice;
            const ta = c.targetChoice;
            let payload;

            if (ch === ta) {
                payload = {
                    game: 'Piedra, Papel o Tijera',
                    resultStr: `${ch} vs ${ta} — ¡EMPATE!`,
                    winner: 'EMPATE',
                    loser: 'Nadie',
                    penalty: 0
                };
                addLog(roomCode, `✂️ PPT entre ${c.challengerName} y ${c.targetName}: Empate (${ch}).`);
            } else {
                const p1Wins = (ch === 'Piedra' && ta === 'Tijera') ||
                               (ch === 'Papel' && ta === 'Piedra') ||
                               (ch === 'Tijera' && ta === 'Papel');
                const winnerId = p1Wins ? c.challenger : c.target;
                const loserId = p1Wins ? c.target : c.challenger;
                const winner = room.players.find(p => p.id === winnerId);
                const loser = room.players.find(p => p.id === loserId);
                if (loser) loser.drinks += 3;

                broadcastPlayers(roomCode);
                payload = {
                    game: 'Piedra, Papel o Tijera',
                    resultStr: `${c.challengerName} (${ch}) vs ${c.targetName} (${ta})`,
                    winner: winner ? winner.name : 'Nadie',
                    loser: loser ? loser.name : 'Nadie',
                    penalty: 3
                };
                addLog(roomCode, `✂️ PPT: ${payload.winner} ganó a ${payload.loser} (+3 tragos).`);
            }

            io.to(c.challenger).emit('minigameResult', payload);
            io.to(c.target).emit('minigameResult', payload);
            delete room.activeChallenges[challengeId];
        } else {
            socket.emit('serverMsg', 'Elección guardada. Esperando a tu rival...');
        }
    });

    // Desconexiones y relevo automático de Máster
    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const leftPlayer = room.players[idx];
                room.players.splice(idx, 1);

                // Limpiar retos donde participara
                for (const cid in room.activeChallenges) {
                    const ch = room.activeChallenges[cid];
                    if (ch.challenger === socket.id || ch.target === socket.id) {
                        const otherId = ch.challenger === socket.id ? ch.target : ch.challenger;
                        io.to(otherId).emit('challengeClosed', `${leftPlayer.name} se desconectó. Reto cancelado.`);
                        delete room.activeChallenges[cid];
                    }
                }

                broadcastPlayers(code);
                addLog(code, `🚪 ${leftPlayer.name} salió de la sala.`);

                if (room.host === socket.id && room.players.length > 0) {
                    room.host = room.players[0].id;
                    room.players[0].isHost = true;
                    io.to(room.host).emit('youAreHost');
                    broadcastPlayers(code);
                    io.to(code).emit('serverMsg', `👑 ${room.players[0].name} es el nuevo Máster.`);
                    addLog(code, `👑 ${room.players[0].name} heredó la corona de Máster.`);
                }

                if (room.state === 'FASE_1' && room.players.length > 0) {
                    if (room.turnPlayerIndex >= room.players.length) room.turnPlayerIndex = 0;
                    emitRoomState(code);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Cefa Party V4 corriendo en http://localhost:${PORT}`);
});
