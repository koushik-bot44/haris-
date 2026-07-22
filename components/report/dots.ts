// Shared score-dot opacity — one strength ramp everywhere dots render
// (History strips, QuestionCard criteria): score 1 → 0.15, score 5 → 0.95.
export const dotOpacity = (v: number) => 0.15 + ((v - 1) / 4) * 0.8;
