// Drop-in replacement layout generator for drawing cards onto the main central pile stack
function createDiscardPileCardUI(card) {
    const cardEl = document.createElement('div');
    cardEl.className = 'card-item discard-stack-card';
    
    // Set text coloration vectors based on suit types dynamically
    const suitColor = ['♥','♦'].includes(card.displaySuit) ? '#e91e63' : '#212121';
    cardEl.style.color = suitColor;

    if (card.displayValue === 'A' && card.suitOverrideActive) {
        cardEl.innerHTML = `
            <div class="card-corner-wrapper faded-out-corners">
                <span>A</span><span>${card.originalSuit}</span>
            </div>
            <div class="card-center-suit vibrant-colored-center">
                ${card.displaySuit}
                <div class="card-owner-tag" style="background-color: ${card.playerColor}">
                    ${card.playedBy}
                </div>
            </div>
        `;
    } else {
        cardEl.innerHTML = `
            <div class="card-corner-wrapper">
                <span>${card.displayValue}</span>
            </div>
            <div class="card-center-suit">
                ${card.displaySuit}
                <div class="card-owner-tag" style="background-color: ${card.playerColor}">
                    ${card.playedBy}
                </div>
            </div>
        `;
    }
    
    return cardEl;
}

// Function layout handler utilized when looping over player hand slots
function createHandCardUIElement(card) {
    const cardEl = document.createElement('div');
    cardEl.className = 'card-item';
    
    // SPECTATOR LOCK FILTER GATING: Check if server passed unmasked properties
    if (card.displayValue) {
        cardEl.innerHTML = `
            <div class="card-corner-wrapper">
                <span>${card.displayValue}</span>
            </div>
            <div class="card-center-suit">${card.displaySuit}</div>
        `;
        cardEl.style.color = ['♥','♦'].includes(card.displaySuit) ? '#e91e63' : '#212121';
    } else {
        // If the server scrubbed the cards because you are still an active player, render a back placeholder card
        cardEl.className = 'card-item card-back-placeholder';
        cardEl.innerHTML = `<div class="inner-pattern">🃏</div>`;
    }
    
    return cardEl;
}
