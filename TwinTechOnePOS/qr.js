/* Offline QR Code generator for short voucher codes (QR Version 1-L alphanumeric). */
window.OnePOSQR = (() => {
  'use strict';
  const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const SIZE = 21;

  function multiply(x, y) {
    let result = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (y & 1) result ^= x;
      y >>>= 1;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    return result;
  }

  function codewords(text) {
    if (!text || text.length > 25 || [...text].some(char => ALPHANUMERIC.indexOf(char) < 0)) {
      throw new Error('QR voucher codes must be 1 to 25 uppercase letters, numbers, or QR-safe punctuation characters.');
    }
    const bits = [];
    const append = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    append(0b0010, 4);
    append(text.length, 9);
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) append(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      else append(ALPHANUMERIC.indexOf(text[i]), 6);
    }
    if (bits.length > 152) throw new Error('Voucher code is too long for its QR code.');
    for (let i = 0; i < Math.min(4, 152 - bits.length); i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    for (let pad = 0; data.length < 19; pad++) data.push(pad % 2 ? 0x11 : 0xEC);

    let generator = [1];
    let root = 1;
    for (let i = 0; i < 7; i++) {
      const next = Array(generator.length + 1).fill(0);
      generator.forEach((coefficient, index) => {
        next[index] ^= coefficient;
        next[index + 1] ^= multiply(coefficient, root);
      });
      generator = next;
      root = multiply(root, 2);
    }
    const remainder = data.concat(Array(7).fill(0));
    for (let i = 0; i < data.length; i++) {
      const factor = remainder[i];
      if (factor) generator.forEach((coefficient, j) => { remainder[i + j] ^= multiply(coefficient, factor); });
    }
    return data.concat(remainder.slice(data.length));
  }

  function matrixFor(text) {
    const modules = Array.from({length: SIZE}, () => Array(SIZE).fill(false));
    const functions = Array.from({length: SIZE}, () => Array(SIZE).fill(false));
    const setFunction = (x, y, dark) => { modules[y][x] = Boolean(dark); functions[y][x] = true; };

    function finder(left, top) {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const x = left + dx, y = top + dy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(x, y, dark);
      }
    }
    finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
    for (let i = 8; i < SIZE - 8; i++) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }
    for (let i = 0; i <= 5; i++) setFunction(8, i, false);
    setFunction(8, 7, false); setFunction(8, 8, false); setFunction(7, 8, false);
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, false);
    for (let i = 0; i < 8; i++) setFunction(SIZE - 1 - i, 8, false);
    for (let i = 8; i < 15; i++) setFunction(8, SIZE - 15 + i, false);
    setFunction(8, SIZE - 8, true);

    const stream = codewords(text).flatMap(byte => Array.from({length: 8}, (_, bit) => (byte >>> (7 - bit)) & 1));
    let bitIndex = 0;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < SIZE; vertical++) {
        const y = ((right + 1) & 2) === 0 ? SIZE - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset++) {
          const x = right - offset;
          if (functions[y][x]) continue;
          const bit = bitIndex < stream.length ? stream[bitIndex++] : 0;
          modules[y][x] = Boolean(bit ^ ((x + y) % 2 === 0 ? 1 : 0));
        }
      }
    }

    const formatData = (0b01 << 3) | 0;
    let remainder = formatData << 10;
    for (let bit = 14; bit >= 10; bit--) if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
    const format = ((formatData << 10) | remainder) ^ 0x5412;
    const formatBit = bit => ((format >>> bit) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunction(8, i, formatBit(i));
    setFunction(8, 7, formatBit(6));
    setFunction(8, 8, formatBit(7));
    setFunction(7, 8, formatBit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, formatBit(i));
    for (let i = 0; i < 8; i++) setFunction(SIZE - 1 - i, 8, formatBit(i));
    for (let i = 8; i < 15; i++) setFunction(8, SIZE - 15 + i, formatBit(i));
    setFunction(8, SIZE - 8, true);
    return modules;
  }

  function svg(code) {
    const matrix = matrixFor(String(code));
    const quietZone = 4;
    const path = [];
    matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`); }));
    const viewSize = SIZE + quietZone * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="QR code for voucher ${code}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path.join('')}" fill="#000"/></svg>`;
  }

  return {svg};
})();
