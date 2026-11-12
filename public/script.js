const socket = io({ reconnectionAttempts: Infinity, reconnectionDelay: 1000 });

let misDatos = {};
let isMaster = false;
let currentRoom = '';
let roomPlayers = [];
let myHand = [];
let currentState = null;
let selectedRivalId = null;
let currentChallengeId = null;
let pendingAction = null; // { type: 'phase1'|'sendCard', answer, cardId }
let myGhost = false;

/* =========================================
   WAKE LOCK & HEARTBEAT ANTI-SUSPENSIÓN
========================================= */
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
});
setInterval(() => {
    if (socket.connected) socket.emit('heartbeat');
}, 15000);

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    requestWakeLock();
}

function getPaloIcon(palo) {
    if (palo === 'Oros') return '🪙';
    if (palo === 'Copas') return '🏆';
    if (palo === 'Espadas') return '⚔️';
    if (palo === 'Bastos') return '🪵';
    return '';
}

/* =========================================
   MODO 1: LA SETA EXPRESS (1 MÓVIL - 41 CARTAS)
========================================= */
let mazoSeta = [];
let contadorAses = 1;

const reglasSeta = {
    1: "¡AS! Trago Incremental: Te toca beber X trago(s).",
    2: "¡DOS! Tú y los lados: Bebes tú y los dos que tienes al lado.",
    3: "¡TRES! Chicos: Todos los chicos de la mesa beben.",
    4: "¡CUATRO! Chicas: Todas las chicas de la mesa beben.",
    5: "¡CINCO! Yo nunca: Di un «Yo nunca...», quien lo haya hecho bebe.",
    6: "¡SEIS! Categorías: Elige un tema. El primero que falle bebe.",
    7: "¡SIETE! Tocar la nariz: ¡El último que se toque la nariz bebe 2!",
    10: "¡SOTA (Poder del guiño)! Guárdala. Si guiñas a alguien y no te pillan, bebe. Si te pillan, bebes tú.",
    11: "¡CABALLO (Esclavo)! Elige a alguien. Le puedes mandar beber tus tragos hasta el próximo caballo.",
    12: "¡REY (Poner norma)! Inventa una norma global. El que la rompa, bebe.",
    "SETA": "¡TE HA CAÍDO LA SETA! 🍄 BÉBETE EL VASO DEL CENTRO A FONDO BLANCO."
};

function nombreCartaSeta(num) {
    if (num === 1) return 'As';
    if (num === 10) return 'Sota';
    if (num === 11) return 'Caballo';
    if (num === 12) return 'Rey';
    return String(num);
}

function iniciarSeta() {
    showScreen('seta-screen');
    mazoSeta = [];
    contadorAses = 1;
    const palos = ['Oros', 'Copas', 'Espadas', 'Bastos'];
    const nums = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12]; // 40 cartas + 1 Seta = 41
    for (let palo of palos) {
        for (let num of nums) {
            mazoSeta.push({ num, palo });
        }
    }
    mazoSeta.push("SETA");
    for (let i = mazoSeta.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mazoSeta[i], mazoSeta[j]] = [mazoSeta[j], mazoSeta[i]];
    }
    document.getElementById('seta-counter').innerText = `Cartas restantes: ${mazoSeta.length}`;
    prepararSiguienteSeta();
}

function sacarCartaSeta() {
    if (mazoSeta.length === 0) return;
    const cartaObj = document.getElementById('seta-deck');
    const carta = mazoSeta.pop();

    if (carta === "SETA") {
        cartaObj.innerHTML = `<div class="card-seta-boom">🍄<br>¡LA SETA!</div>`;
        document.body.style.background = "#7f0000";
        document.getElementById('seta-card-title').innerText = "¡FIN DEL JUEGO!";
        document.getElementById('seta-card-rule').innerText = reglasSeta["SETA"];
    } else {
        const label = nombreCartaSeta(carta.num);
        cartaObj.innerHTML = `<div class="card-front palo-${carta.palo}">${label}<br>${getPaloIcon(carta.palo)}<br><small>${carta.palo}</small></div>`;
        let textoRegla = reglasSeta[carta.num];
        if (carta.num === 1) {
            textoRegla = textoRegla.replace("X", contadorAses);
            contadorAses++;
            if (contadorAses > 16) contadorAses = 1;
        }
        document.getElementById('seta-card-title').innerText = `${label} de ${carta.palo}`;
        document.getElementById('seta-card-rule').innerText = textoRegla;
    }

    document.getElementById('seta-chivato').classList.remove('hidden');
    document.getElementById('btn-next-seta').classList.remove('hidden');
    cartaObj.onclick = null;
    document.getElementById('seta-counter').innerText = `Cartas restantes: ${mazoSeta.length}`;
}

function prepararSiguienteSeta() {
    if (mazoSeta.length === 0) {
        iniciarSeta();
        return;
    }
    const cartaObj = document.getElementById('seta-deck');
    cartaObj.innerHTML = `<div class="card-back">TOCA PARA ROBAR</div>`;
    cartaObj.onclick = sacarCartaSeta;
    document.getElementById('seta-chivato').classList.add('hidden');
    document.getElementById('btn-next-seta').classList.add('hidden');
    document.body.style.background = "#111424";
}

function salirSeta() {
    document.body.style.background = "#111424";
    showScreen('main-menu');
}

/* =========================================
   MODO 2: LA PIRÁMIDE (LOGIN & LOBBY)
========================================= */
function joinPiramide() {
    const user = document.getElementById('username').value.trim();
    const room = document.getElementById('roomCode').value.toUpperCase().trim();
    if (!user || !room) {
        document.getElementById('login-error').innerText = 'Escribe tu apodo y el código de sala.';
        return;
    }
    document.getElementById('login-error').innerText = '';
    document.getElementById('btn-join').disabled = true;
    socket.emit('joinRoom', { username: user, roomCode: room });
}

socket.on('errorMsg', (msg) => {
    document.getElementById('login-error').innerText = msg;
    document.getElementById('btn-join').disabled = false;
    showNotification(msg);
});

function showNotification(msg) {
    const noti = document.getElementById('server-notification');
    noti.innerText = msg;
    noti.classList.remove('hidden');
    clearTimeout(noti._t);
    noti._t = setTimeout(() => noti.classList.add('hidden'), 3800);
}

socket.on('serverMsg', showNotification);

socket.on('joined', ({ roomCode, player, isHost }) => {
    misDatos = player;
    isMaster = isHost;
    currentRoom = roomCode;
    showScreen('piramide-game');
    if (isMaster) document.getElementById('master-btn').classList.remove('hidden');
});

socket.on('youAreHost', () => {
    isMaster = true;
    document.getElementById('master-btn').classList.remove('hidden');
    updateMasterButtons();
});

socket.on('updatePlayers', (players) => {
    roomPlayers = players;
    const list = document.getElementById('players-list');
    list.innerHTML = '';

    const yo = players.find(p => p.id === socket.id);
    if (yo) document.getElementById('mis-tragos').innerText = yo.drinks;

    players.forEach(p => {
        const isTurn = currentState && currentState.state === 'FASE_1' && currentState.activePlayerId === p.id;
        const crown = p.isHost ? '👑 ' : '';
        const ghost = p.ghost ? ' 👻' : '';
        list.innerHTML += `<div class="player-tag ${isTurn ? 'is-turn' : ''} ${p.ghost ? 'is-ghost' : ''}">${crown}${p.name}${ghost} • 🍺${p.drinks} • 🃏${p.cardCount}</div>`;
    });

    renderMinigameRivals();
});

socket.on('updateLogs', (logs) => {
    const logList = document.getElementById('log-list');
    logList.innerHTML = logs.map(l => `<div class="log-item"><b>[${l.time}]</b> ${l.text}</div>`).join('');
});

function toggleLogDrawer() {
    document.getElementById('log-drawer').classList.toggle('hidden');
}

function toggleGhostMode() {
    myGhost = !myGhost;
    const btn = document.getElementById('btn-ghost-toggle');
    btn.innerText = myGhost ? '👻 Fantasma' : '👻 Activo';
    btn.classList.toggle('ghost-on', myGhost);
    socket.emit('toggleGhost', { roomCode: currentRoom });
}

/* =========================================
   CONTROLES MÁSTER (CON COOLDOWN 1.5s)
========================================= */
function toggleMasterPanel() {
    document.getElementById('master-panel').classList.toggle('hidden');
}

function masterAction(eventName) {
    const btns = document.querySelectorAll('.btn-master-item');
    btns.forEach(b => b.disabled = true);
    socket.emit(eventName, { roomCode: currentRoom });
    setTimeout(() => {
        btns.forEach(b => b.disabled = false);
    }, 1500);
}

function updateMasterButtons() {
    if (!isMaster || !currentState) return;
    const s = currentState.state;
    document.getElementById('btn-master-start').classList.toggle('hidden', s !== 'LOBBY' && s !== 'HALL_OF_FAME');
    document.getElementById('btn-master-card').classList.toggle('hidden', s !== 'PIRAMIDE_FILA');
    document.getElementById('btn-master-auction').classList.toggle('hidden', s !== 'LISTO_SUBASTA');
    document.getElementById('btn-master-event').classList.toggle('hidden', s !== 'POST_SUBASTA');
}

/* =========================================
   SINCRONIZACIÓN DE ESTADO Y TABLERO
========================================= */
socket.on('stateSync', (st) => {
    currentState = st;
    document.getElementById('active-rule-text').innerText = st.activeRule;
    updateMasterButtons();
    renderCenterBoard();
    renderHand();
});

socket.on('phaseTransition', (msg) => {
    showNotification(msg);
});

socket.on('eventRevealed', (eventText) => {
    showNotification(eventText);
});

function renderCenterBoard() {
    const mesa = document.getElementById('mesa-central');
    const st = currentState;
    if (!st) return;

    if (st.state === 'LOBBY') {
        mesa.innerHTML = `<h3>Sala ${currentRoom}</h3><p style="margin-top:8px; color:#ccc;">Esperando a que el Máster pulse 👑 → Repartir (Fase 1).</p>`;
        return;
    }

    if (st.state === 'FASE_1') {
        const isMyTurn = st.activePlayerId === socket.id;
        const r = st.phase1Round;
        let qTitle = '';
        let controlsHtml = '';

        if (r === 1) {
            qTitle = 'Ronda 1: Elige Palo (1 Trago)';
            controlsHtml = `
                <div class="options-grid">
                    <button class="opt-btn palo-Oros" onclick="preparePhase1Answer('Oros', true)">🪙 Oros</button>
                    <button class="opt-btn palo-Copas" onclick="preparePhase1Answer('Copas', true)">🏆 Copas</button>
                    <button class="opt-btn palo-Espadas" onclick="preparePhase1Answer('Espadas', true)">⚔️ Espadas</button>
                    <button class="opt-btn palo-Bastos" onclick="preparePhase1Answer('Bastos', true)">🪵 Bastos</button>
                </div>`;
        } else if (r === 2) {
            const c1 = myHand[0];
            qTitle = `Ronda 2: ¿Mayor, Menor o Igual que ${c1 ? c1.label : ''}? (2 Tragos)`;
            controlsHtml = `
                <div class="options-grid cols-3">
                    <button class="opt-btn" onclick="preparePhase1Answer('Mayor', true)">⬆️ Mayor</button>
                    <button class="opt-btn" onclick="preparePhase1Answer('Igual', true)">🟰 Igual</button>
                    <button class="opt-btn" onclick="preparePhase1Answer('Menor', true)">⬇️ Menor</button>
                </div>`;
        } else if (r === 3) {
            const c1 = myHand[0];
            const c2 = myHand[1];
            qTitle = `Ronda 3: ¿Dentro, Igual o Fuera de ${c1 ? c1.label : ''} y ${c2 ? c2.label : ''}? (3 Tragos)`;
            controlsHtml = `
                <div class="options-grid cols-3">
                    <button class="opt-btn" onclick="preparePhase1Answer('Dentro', true)">↔️ Dentro</button>
                    <button class="opt-btn" onclick="preparePhase1Answer('Igual', true)">🟰 Igual</button>
                    <button class="opt-btn" onclick="preparePhase1Answer('Fuera', true)">🔀 Fuera</button>
                </div>`;
        } else if (r === 4) {
            qTitle = 'Ronda 4: Apuesta Número Exacto (Mandas ese nº o bebes la diferencia)';
            let btns = '';
            for (let n = 1; n <= 12; n++) {
                const lbl = n === 1 ? 'As' : n === 10 ? 'Sota' : n === 11 ? 'Cab' : n === 12 ? 'Rey' : n;
                btns += `<button class="opt-btn" onclick="preparePhase1Answer('${n}', true)">${lbl}</button>`;
            }
            controlsHtml = `<div class="options-grid cols-4">${btns}</div>`;
        }

        if (isMyTurn) {
            mesa.innerHTML = `
                <div class="phase1-box my-turn-glow">
                    <h3 style="color:#00ff88;">⚡ ¡ES TU TURNO! ⚡</h3>
                    <p style="margin-top:6px;">${qTitle}</p>
                    ${controlsHtml}
                </div>`;
        } else {
            mesa.innerHTML = `
                <div class="phase1-box">
                    <h3>Fase 1 • Ronda ${r} de 4</h3>
                    <p style="margin-top:10px; color:#43d8c9; font-size:1.1rem;">Turno de <b>${st.activePlayerName}</b>...</p>
                </div>`;
        }
        return;
    }

    // Fases de Pirámide / Subasta / Evento
    let html = `<div style="margin-bottom:8px; font-weight:bold; color:#43d8c9;">Fila ${st.currentRow} de 4 • Vale ${st.currentRow} trago(s)</div>`;

    if (st.state === 'SUBASTA' && st.auction) {
        const a = st.auction;
        html += `
            <div class="auction-box ${a.isOvertime ? 'overtime' : ''}">
                <h3>🔨 ¡SUBASTA EN VIVO!</h3>
                <p>Carta en juego: <b class="palo-${a.card.palo}">${a.card.label} de ${a.card.palo}</b></p>
                <div class="auction-timer">${a.secondsLeft}s ${a.isOvertime ? '🔥 PRÓRROGA' : ''}</div>
                <p>Puja actual: <b style="color:gold; font-size:1.3rem;">${a.bid} tragos</b> (${a.leaderName})</p>
                <div class="bid-buttons">
                    <button class="btn-bid" onclick="placeBid(1)">+1</button>
                    <button class="btn-bid" onclick="placeBid(3)">+3</button>
                    <button class="btn-bid" onclick="placeBid(5)">+5</button>
                </div>
            </div>`;
        mesa.innerHTML = html;
        return;
    }

    if (st.state === 'LISTO_SUBASTA') {
        html += `<p style="color:gold; margin-bottom:10px; font-weight:bold;">Fila completada. Esperando a que el Máster abra la Subasta 🔨</p>`;
    } else if (st.state === 'POST_SUBASTA') {
        html += `<p style="color:#e94560; margin-bottom:10px; font-weight:bold;">Subasta cerrada. Esperando a que el Máster desvele el Evento 👁️</p>`;
    }

    // Pintar Pirámide (Cima Fila 4 = [9], Fila 3 = [7,8], Fila 2 = [4,5,6], Base Fila 1 = [0,1,2,3])
    const rows = [[9], [7, 8], [4, 5, 6], [0, 1, 2, 3]];
    rows.forEach(indices => {
        html += `<div class="pyramid-row">`;
        indices.forEach(idx => {
            const c = st.pyramid[idx];
            if (c && c.revealed) {
                html += `<div class="card-board front palo-${c.palo}">${c.label}<br>${getPaloIcon(c.palo)}</div>`;
            } else {
                html += `<div class="card-board back">👁️</div>`;
            }
        });
        html += `</div>`;
    });

    mesa.innerHTML = html;
}

/* =========================================
   SELECTOR VISUAL DE VÍCTIMA (SIN CONFIRM)
========================================= */
function preparePhase1Answer(answer, needsTargetIfWin) {
    const rivals = roomPlayers.filter(p => p.id !== socket.id);
    if (!needsTargetIfWin || rivals.length === 0) {
        socket.emit('answerPhase1', { roomCode: currentRoom, answer, targetId: null });
        return;
    }
    pendingAction = { type: 'phase1', answer };
    openTargetModal('🎯 ¿A quién mandas tragos si aciertas?', 'Elige jugador antes de destapar tu carta:');
}

function openTargetModal(title, desc) {
    document.getElementById('target-modal-title').innerText = title;
    document.getElementById('target-modal-desc').innerText = desc;
    const grid = document.getElementById('target-avatars-grid');
    grid.innerHTML = '';

    const rivals = roomPlayers.filter(p => p.id !== socket.id);
    rivals.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'avatar-option';
        btn.innerText = `${p.name} (🍺${p.drinks})`;
        btn.onclick = () => confirmTargetSelection(p.id);
        grid.appendChild(btn);
    });

    document.getElementById('target-selector-modal').classList.remove('hidden');
}

function closeTargetModal() {
    document.getElementById('target-selector-modal').classList.add('hidden');
    pendingAction = null;
}

function confirmTargetSelection(targetId) {
    document.getElementById('target-selector-modal').classList.add('hidden');
    if (!pendingAction) return;

    if (pendingAction.type === 'phase1') {
        socket.emit('answerPhase1', {
            roomCode: currentRoom,
            answer: pendingAction.answer,
            targetId
        });
    } else if (pendingAction.type === 'sendCard') {
        socket.emit('sendCard', {
            roomCode: currentRoom,
            cardId: pendingAction.cardId,
            targetId
        });
    }
    pendingAction = null;
}

/* =========================================
   INVENTARIO INFERIOR Y SUBASTAS
========================================= */
socket.on('updateHand', (hand) => {
    myHand = hand;
    renderHand();
});

function renderHand() {
    const handDiv = document.getElementById('my-cards');
    handDiv.innerHTML = '';

    // Comprobar qué números están destapados en la fila actual de la pirámide para efecto foco neón
    let activeRowNums = [];
    if (currentState && (currentState.state === 'PIRAMIDE_FILA' || currentState.state === 'LISTO_SUBASTA')) {
        const rowIndices = { 1: [0, 1, 2, 3], 2: [4, 5, 6], 3: [7, 8], 4: [9] }[currentState.currentRow];
        activeRowNums = rowIndices
            .map(i => currentState.pyramid[i])
            .filter(c => c && c.revealed)
            .map(c => c.num);
    }

    myHand.forEach(card => {
        const isMatch = activeRowNums.includes(card.num);
        const div = document.createElement('div');
        div.className = `mini-card palo-${card.palo} ${isMatch ? 'neon-match' : ''}`;
        div.innerHTML = `<span>${card.label}</span><span>${getPaloIcon(card.palo)}</span>`;
        div.onclick = () => {
            if (roomPlayers.length <= 1) {
                showNotification('Necesitas más jugadores en la sala para mandar cartas.');
                return;
            }
            pendingAction = { type: 'sendCard', cardId: card.id };
            openTargetModal(`🃏 Mandar ${card.label} de ${card.palo}`, 'La carta pasará al inventario del jugador elegido:');
        };
        handDiv.appendChild(div);
    });
}

function placeBid(increment) {
    socket.emit('placeBid', { roomCode: currentRoom, increment });
}

/* =========================================
   MINIJUEGOS DE PAUSA (COINFLIP & PPT)
========================================= */
function togglePauseMenu() {
    renderMinigameRivals();
    document.getElementById('pause-modal').classList.toggle('hidden');
}

function renderMinigameRivals() {
    const grid = document.getElementById('minigame-rivals-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const rivals = roomPlayers.filter(p => p.id !== socket.id);
    if (rivals.length === 0) {
        grid.innerHTML = '<p style="grid-column:span 2; color:#888;">No hay más jugadores en la sala.</p>';
        selectedRivalId = null;
        return;
    }

    if (!rivals.some(r => r.id === selectedRivalId)) {
        selectedRivalId = rivals[0].id;
    }

    rivals.forEach(p => {
        const btn = document.createElement('button');
        btn.className = `avatar-option ${p.id === selectedRivalId ? 'selected' : ''}`;
        btn.innerText = `${p.name} (🍺${p.drinks})`;
        btn.onclick = () => {
            selectedRivalId = p.id;
            renderMinigameRivals();
        };
        grid.appendChild(btn);
    });
}

function sendChallenge(gameType) {
    if (!selectedRivalId) {
        showNotification('Selecciona primero a un rival.');
        return;
    }
    socket.emit('sendChallenge', {
        roomCode: currentRoom,
        targetId: selectedRivalId,
        gameType
    });
    togglePauseMenu();
}

socket.on('challengeWaiting', ({ targetName }) => {
    showNotification(`⏳ Esperando a que ${targetName} acepte el reto (15s)...`);
});

socket.on('incomingChallenge', ({ challengeId, challengerName, gameType }) => {
    currentChallengeId = challengeId;
    const gameName = gameType === 'coinflip' ? '🪙 Coinflip de la Muerte' : '✂️ Piedra, Papel o Tijera';
    document.getElementById('incoming-challenge-text').innerHTML =
        `<b>${challengerName}</b> te reta a:<br><span style="color:#43d8c9; font-size:1.15rem;">${gameName}</span>`;

    document.getElementById('incoming-challenge-modal').classList.remove('hidden');
    const bar = document.getElementById('challenge-timer');
    bar.style.transition = 'none';
    bar.style.width = '100%';
    setTimeout(() => {
        bar.style.transition = 'width 15s linear';
        bar.style.width = '0%';
    }, 50);
});

socket.on('challengeClosed', (msg) => {
    document.getElementById('incoming-challenge-modal').classList.add('hidden');
    currentChallengeId = null;
    if (msg) showNotification(msg);
});

function acceptChallenge() {
    document.getElementById('incoming-challenge-modal').classList.add('hidden');
    socket.emit('acceptChallenge', { roomCode: currentRoom, challengeId: currentChallengeId });
}

function rejectChallenge() {
    document.getElementById('incoming-challenge-modal').classList.add('hidden');
    socket.emit('rejectChallenge', { roomCode: currentRoom, challengeId: currentChallengeId });
    currentChallengeId = null;
}

socket.on('challengeAccepted', (challenge) => {
    currentChallengeId = challenge.id;
    if (challenge.gameType === 'coinflip') {
        if (socket.id === challenge.target) {
            document.querySelectorAll('.coin-choice-btn').forEach(b => b.disabled = false);
            document.getElementById('coinflip-choice-modal').classList.remove('hidden');
        } else {
            showNotification(`🪙 ${challenge.targetName} está eligiendo Cara o Cruz...`);
        }
    } else if (challenge.gameType === 'rps') {
        document.querySelectorAll('.rps-choice-btn').forEach(b => b.disabled = false);
        document.getElementById('rps-choice-modal').classList.remove('hidden');
    }
});

function submitCoinflip(choice) {
    document.querySelectorAll('.coin-choice-btn').forEach(b => b.disabled = true);
    document.getElementById('coinflip-choice-modal').classList.add('hidden');
    socket.emit('coinflipChoice', { roomCode: currentRoom, challengeId: currentChallengeId, choice });
}

function submitRPS(choice) {
    document.querySelectorAll('.rps-choice-btn').forEach(b => b.disabled = true);
    document.getElementById('rps-choice-modal').classList.add('hidden');
    socket.emit('rpsChoice', { roomCode: currentRoom, challengeId: currentChallengeId, choice });
}

socket.on('playCoinAnimation', ({ yourSide, rivalSide }) => {
    document.getElementById('coin-sides-info').innerText = `Tú vas con ${yourSide} • Rival con ${rivalSide}`;
    document.getElementById('animation-modal').classList.remove('hidden');
});

socket.on('minigameResult', ({ game, resultStr, winner, loser, penalty }) => {
    document.getElementById('animation-modal').classList.add('hidden');
    document.getElementById('result-title').innerText = `🏆 ${game}`;
    document.getElementById('result-str').innerText = resultStr;
    document.getElementById('result-winner').innerText = winner === 'EMPATE' ? '¡EMPATE!' : `${winner} GANA`;
    document.getElementById('result-loser').innerText = penalty > 0 ? `${loser} bebe ${penalty} tragos.` : 'Nadie bebe.';
    document.getElementById('result-modal').classList.remove('hidden');
    currentChallengeId = null;
});

function closeResultModal() {
    document.getElementById('result-modal').classList.add('hidden');
}

/* =========================================
   HALL OF FAME FINAL
========================================= */
socket.on('gameFinished', ({ ranking, soberName }) => {
    const list = document.getElementById('hof-list');
    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = ranking.map((p, idx) =>
        `<div style="padding:6px 0; border-bottom:1px solid #333;">${medals[idx] || '🍺'} <b>${p.name}</b>: ${p.drinks} tragos</div>`
    ).join('');
    document.getElementById('hof-sober-penalty').innerText = `🚨 Castigo al más sobrio (${soberName}): +5 TRAGOS EXTRA`;
    document.getElementById('hof-modal').classList.remove('hidden');
});

function closeHofModal() {
    document.getElementById('hof-modal').classList.add('hidden');
}
