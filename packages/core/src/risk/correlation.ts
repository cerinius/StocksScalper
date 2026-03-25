import { clamp } from "@stock-radar/shared";

export const calculatePearsonCorrelation = (left: number[], right: number[]) => {
  const length = Math.min(left.length, right.length);
  if (length < 3) return 0;

  const sampleLeft = left.slice(-length);
  const sampleRight = right.slice(-length);
  const meanLeft = sampleLeft.reduce((total, value) => total + value, 0) / length;
  const meanRight = sampleRight.reduce((total, value) => total + value, 0) / length;

  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (let index = 0; index < length; index += 1) {
    const leftDelta = sampleLeft[index] - meanLeft;
    const rightDelta = sampleRight[index] - meanRight;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);
  if (denominator === 0) return 0;
  return clamp(numerator / denominator, -1, 1);
};
