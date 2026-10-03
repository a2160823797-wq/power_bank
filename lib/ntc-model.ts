import { NTC_RNOR_DECIOHMS } from './ntc-table';

export const NTC_MIN = -25;
export const NTC_MAX = 125;

export function targetResistance(temperature: number) {
  if (!Number.isInteger(temperature) || temperature < -40 || temperature > 125)
    throw new RangeError('温度不在温阻表内');
  return NTC_RNOR_DECIOHMS[temperature + 40] / 10;
}

// AD5270 Rev.H Eq.1 的 R-Perf 名义值；以后用实测逐码表替换此函数
export function codeResistance(code: number) {
  return (code * 100000) / 1024;
}

export function equivalentTemperature(resistance: number) {
  for (let index = 0; index < NTC_RNOR_DECIOHMS.length - 1; index++) {
    const upper = NTC_RNOR_DECIOHMS[index] / 10;
    const lower = NTC_RNOR_DECIOHMS[index + 1] / 10;
    if (resistance <= upper && resistance >= lower)
      return index - 40 + (upper - resistance) / (upper - lower);
  }
  return null;
}

export function temperatureModel(temperature: number) {
  const target = targetResistance(temperature);
  let code = 0;
  for (let candidate = 1; candidate <= 1023; candidate++) {
    if (
      Math.abs(codeResistance(candidate) - target) <
      Math.abs(codeResistance(code) - target)
    )
      code = candidate;
  }
  const output = codeResistance(code);
  const equivalent = equivalentTemperature(output);
  return {
    target,
    code,
    output,
    error: output - target,
    errorPercent: ((output - target) / target) * 100,
    temperatureError: equivalent === null ? null : equivalent - temperature,
    accuracy:
      code >= 75
        ? '±1%'
        : code >= 50
          ? '±2%'
          : code >= 25
            ? '±3%'
            : '低码区未保证',
  };
}
