import confetti from "canvas-confetti";

export function firePaymentConfetti() {
  const colors = ["#22d3ee", "#0891b2", "#22c55e", "#f59e0b"];
  const end = Date.now() + 3000;

  void confetti({
    particleCount: 80,
    spread: 70,
    origin: { y: 0.5 },
    colors,
    disableForReducedMotion: true,
    scalar: 0.9,
  });

  setTimeout(() => {
    void confetti({
      particleCount: 50,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.6 },
      colors,
      disableForReducedMotion: true,
    });
    void confetti({
      particleCount: 50,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.6 },
      colors,
      disableForReducedMotion: true,
    });
  }, 200);

  const stream = () => {
    if (Date.now() > end) return;
    void confetti({
      particleCount: 30,
      spread: 100,
      startVelocity: 30,
      origin: { x: Math.random(), y: Math.random() * 0.5 },
      colors,
      disableForReducedMotion: true,
      scalar: 0.8,
      ticks: 200,
    });
    setTimeout(stream, 400);
  };
  stream();
}
