/** Deterministic dummy data for the mock marketplace server. */
let seed = 42;
export function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
export function resetRandom(s = 42) {
  seed = s;
}
export const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;

const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Riley', 'Charlie', 'Avery'];
const LAST = ['Dummy', 'Example', 'Sample', 'Testington', 'Placeholder'];
const UK_CITIES: Array<[string, string]> = [['London', 'SW1A 1AA'], ['Leeds', 'LS1 1AA'], ['Manchester', 'M1 1AA'], ['Bristol', 'BS1 1AA'], ['Glasgow', 'G1 1AA']];
const US_CITIES: Array<[string, string, string]> = [['Austin', 'TX', '73301'], ['Denver', 'CO', '80201'], ['Miami', 'FL', '33101']];

export function dummyBuyer(country: 'GB' | 'US') {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  if (country === 'GB') {
    const [city, postcode] = pick(UK_CITIES);
    return { name, email: `${name.toLowerCase().replace(' ', '.')}@example.invalid`, phone: '07700900000', line1: `${Math.ceil(rand() * 99)} Test Street`, city, region: '', postcode, country };
  }
  const [city, region, postcode] = pick(US_CITIES);
  return { name, email: `${name.toLowerCase().replace(' ', '.')}@example.invalid`, phone: '5555550100', line1: `${Math.ceil(rand() * 999)} Example Ave`, city, region, postcode, country };
}

/** Listings that "already exist" on each marketplace (SKUs match the demo catalogue). */
export const EXISTING_SKUS = ['FR-10001-10', 'FR-10001-12', 'FR-10002-M', 'FR-10003-L'];
