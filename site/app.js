// Static illustrations only. No engine connections, API requests or external libraries.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionButton = document.getElementById("motion-toggle");
const flow = document.getElementById("hero-flow");
let motionPaused = false;
function updateMotion() {
  motionButton.hidden = reducedMotion.matches;
  flow.classList.toggle("motion-paused", motionPaused);
  motionButton.setAttribute("aria-pressed", String(motionPaused));
  motionButton.textContent = motionPaused ? "Resume motion" : "Pause motion";
}
motionButton.addEventListener("click", () => {
  motionPaused = !motionPaused;
  updateMotion();
});
reducedMotion.addEventListener("change", updateMotion);
updateMotion();

for (const node of document.querySelectorAll("[data-node]")) {
  const block = document.querySelector(`[data-source="${node.dataset.node}"]`);
  const highlight = () => block.classList.add("is-highlighted");
  const clear = () => {
    if (!node.matches(":hover, :focus")) block.classList.remove("is-highlighted");
  };
  node.addEventListener("mouseenter", highlight);
  node.addEventListener("mouseleave", clear);
  node.addEventListener("focus", highlight);
  node.addEventListener("blur", clear);
  node.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-source]")) other.classList.remove("is-highlighted");
    highlight();
  });
}

const stageDescriptions = {
  received:
    "Input arrives and is validated. Invalid input is rejected; it does not enter the accepted processing path.",
  accepted:
    "The packet is written to the durable journal before input acknowledgement. It gets a packet_id and the pipeline version that accepted it.",
  processing:
    "Nodes transform, tap, filter, route or ask an agent. Each node result is committed before the next node runs. Filtered packets end here without delivery.",
  writing:
    "The output connector writes to its destination. It uses an idempotency key where supported; a successful write alone does not satisfy an explicit verification check.",
  verifying:
    "The configured check determines whether delivery is satisfied. Default ack trusts the connector; explicit checks can inspect a row, a file, an HTTP destination or an external acknowledgement.",
  delivered:
    "The output connector reports a successful write and the configured delivery check passes. That packet is delivered.",
};
for (const button of document.querySelectorAll("[data-stage]")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-stage]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    document.getElementById("stage-detail").textContent = stageDescriptions[button.dataset.stage];
  });
}

const crashButton = document.getElementById("crash-button");
const message = document.getElementById("recovery-message");
const packet2 = document.getElementById("packet2-state");
const packet3 = document.getElementById("packet3-state");
let recoveryRunning = false;
let recoveryTimer;
function packet(element, text, className = "") {
  element.textContent = text;
  element.className = className;
}
const recoveryFrames = [
  () => {
    packet(packet2, "interrupted", "state-error");
    packet(packet3, "pending");
    document.getElementById("packet2-commit").textContent = "stamp";
    document.getElementById("packet3-commit").textContent = "accepted";
    message.textContent = "Runner crashed. The journal and committed results remain on disk.";
  },
  () => {
    packet(packet2, "→ writing", "state-working");
    message.textContent = "Runner restarts. #02 resumes after stamp; an uncommitted write may repeat.";
  },
  () => {
    packet(packet2, "→ verifying", "state-working");
    packet(packet3, "→ processing", "state-working");
    message.textContent = "#02 checks its output. #03 starts from the input held in the journal.";
  },
  () => {
    packet(packet2, "✓ delivered", "state-good");
    packet(packet3, "→ verifying", "state-working");
    document.getElementById("packet2-commit").textContent = "delivery";
    document.getElementById("packet3-commit").textContent = "stamp";
    message.textContent = "#02's delivery is committed. #03 has processed and written its output.";
  },
  () => {
    packet(packet3, "✓ delivered", "state-good");
    document.getElementById("packet3-commit").textContent = "delivery";
    message.textContent = "Recovery complete. Both pending packets reached delivered on their original version.";
    recoveryRunning = false;
    crashButton.disabled = false;
    crashButton.textContent = "Replay the simulation ↻";
  },
];
function finishRecovery() {
  clearTimeout(recoveryTimer);
  for (const frame of recoveryFrames) frame();
}
crashButton.hidden = false;
crashButton.addEventListener("click", () => {
  if (recoveryRunning) return;
  recoveryRunning = true;
  crashButton.disabled = true;
  crashButton.textContent = "Recovering…";
  let frameIndex = 0;
  const step = () => {
    recoveryFrames[frameIndex++]();
    if (frameIndex < recoveryFrames.length) recoveryTimer = setTimeout(step, 1200);
  };
  if (reducedMotion.matches) finishRecovery();
  else step();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches && recoveryRunning) finishRecovery();
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-view]")) {
      const selected = other === button;
      other.setAttribute("aria-pressed", String(selected));
      document.getElementById(`${other.dataset.view}-preview`).hidden = !selected;
    }
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    const originalLabel = button.textContent;
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      button.textContent = "Copied ✓";
      document.getElementById("copy-status").textContent = "Commands copied to clipboard.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.getElementById("copy-status").textContent =
        "Clipboard unavailable. Commands selected; press Control+C or Command+C to copy.";
      button.textContent = "Text selected";
    }
    setTimeout(() => {
      button.textContent = originalLabel;
    }, 2200);
  });
}
