export function encrypt(contractId: number, injectionPointId: number, locationIdx?: number) {
  return contractId * 100000000 + injectionPointId * 10000 + (locationIdx || 0);
}

export function decrypt(value: number) {
  const contractId = Math.floor(value / 100000000);
  const injectionPointId = Math.floor(value / 10000) - contractId * 10000;
  const locationIdx = value - contractId * 100000000 - injectionPointId * 10000;

  return {contractId, injectionPointId, locationIdx};
}
