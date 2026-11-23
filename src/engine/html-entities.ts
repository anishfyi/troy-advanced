// HTML5 character reference (entity) decoder.
// Supports named HTML5 entities (case-sensitive, including all HTML4/Latin-1, Greek,
// punctuation, math, arrows, symbols, and common HTML5 additions), legacy semicolon-less
// named entities with HTML5 attribute-mode safety, and numeric decimal/hexadecimal
// references with WHATWG Windows-1252 C1 remapping, astral code point support, and
// invalid/surrogate replacement (U+FFFD).

export interface DecodeHtmlEntitiesOptions {
  /**
   * When true, applies HTML5 attribute value rules: semicolon-less legacy named
   * references (such as `&copy`) are not decoded when followed by `=` or an ASCII
   * alphanumeric, preventing corruption of query strings like `href="/s?a=1&copy=2"`.
   * Default: false.
   */
  attributeMode?: boolean
}

/**
 * WHATWG HTML5 Section 13.2.5.80 Windows-1252 C1 numeric character reference remapping table.
 */
const WINDOWS_1252_NUMERIC_MAP: Readonly<Record<number, number>> = {
  0x80: 0x20ac, // €
  0x82: 0x201a, // ‚
  0x83: 0x0192, // ƒ
  0x84: 0x201e, // „
  0x85: 0x2026, // …
  0x86: 0x2020, // †
  0x87: 0x2021, // ‡
  0x88: 0x02c6, // ˆ
  0x89: 0x2030, // ‰
  0x8a: 0x0160, // Š
  0x8b: 0x2039, // ‹
  0x8c: 0x0152, // Œ
  0x8e: 0x017d, // Ž
  0x91: 0x2018, // ‘
  0x92: 0x2019, // ’
  0x93: 0x201c, // “
  0x94: 0x201d, // ”
  0x95: 0x2022, // •
  0x96: 0x2013, // –
  0x97: 0x2014, // —
  0x98: 0x02dc, // ˜
  0x99: 0x2122, // ™
  0x9a: 0x0161, // š
  0x9b: 0x203a, // ›
  0x9c: 0x0153, // œ
  0x9e: 0x017e, // ž
  0x9f: 0x0178, // Ÿ
}

/**
 * All 106 HTML4/HTML5 legacy named character references that may appear without a
 * trailing semicolon in HTML5 text (subject to attribute-mode boundary checks).
 */
export const HTML5_LEGACY_NAMED_ENTITIES: ReadonlySet<string> = new Set([
  'AElig', 'AMP', 'Aacute', 'Acirc', 'Agrave', 'Aring', 'Atilde', 'Auml',
  'COPY', 'Ccedil', 'ETH', 'Eacute', 'Ecirc', 'Egrave', 'Euml', 'GT',
  'Iacute', 'Icirc', 'Igrave', 'Iuml', 'LT', 'Ntilde', 'Oacute', 'Ocirc',
  'Ograve', 'Oslash', 'Otilde', 'Ouml', 'QUOT', 'REG', 'THORN', 'Uacute',
  'Ucirc', 'Ugrave', 'Uuml', 'Yacute', 'aacute', 'acirc', 'acute', 'aelig',
  'agrave', 'amp', 'aring', 'atilde', 'auml', 'brvbar', 'ccedil', 'cedil',
  'cent', 'copy', 'curren', 'deg', 'divide', 'eacute', 'ecirc', 'egrave',
  'eth', 'euml', 'frac12', 'frac14', 'frac34', 'gt', 'iacute', 'icirc',
  'iexcl', 'igrave', 'iquest', 'iuml', 'laquo', 'lt', 'macr', 'micro',
  'middot', 'nbsp', 'not', 'ntilde', 'oacute', 'ocirc', 'ograve', 'ordf',
  'ordm', 'oslash', 'otilde', 'ouml', 'para', 'plusmn', 'pound', 'quot',
  'raquo', 'reg', 'sect', 'shy', 'sup1', 'sup2', 'sup3', 'szlig', 'thorn',
  'times', 'uacute', 'ucirc', 'ugrave', 'uml', 'uuml', 'yacute', 'yen',
  'yuml',
])

/**
 * Comprehensive HTML5 named character reference table (case-sensitive per WHATWG HTML5).
 */
export const HTML5_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  // Core XML / HTML markup & whitespace entities
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: '\u00a0',
  NonBreakingSpace: '\u00a0',
  Tab: '\t',
  NewLine: '\n',

  // ASCII punctuation HTML5 named aliases
  excl: '!',
  num: '#',
  dollar: '$',
  percnt: '%',
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  equals: '=',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  Hat: '^',
  lowbar: '_',
  grave: '`',
  DiacriticalGrave: '`',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  VerticalLine: '|',
  rcub: '}',
  rbrace: '}',

  // ISO 8859-1 / Latin-1 Supplement symbols (U+00A1..U+00BF)
  iexcl: '\u00a1',
  cent: '\u00a2',
  pound: '\u00a3',
  curren: '\u00a4',
  yen: '\u00a5',
  brvbar: '\u00a6',
  sect: '\u00a7',
  uml: '\u00a8',
  die: '\u00a8',
  Dot: '\u00a8',
  copy: '\u00a9',
  COPY: '\u00a9',
  ordf: '\u00aa',
  laquo: '\u00ab',
  not: '\u00ac',
  shy: '\u00ad',
  reg: '\u00ae',
  REG: '\u00ae',
  circledR: '\u00ae',
  macr: '\u00af',
  strns: '\u00af',
  deg: '\u00b0',
  plusmn: '\u00b1',
  pm: '\u00b1',
  PlusMinus: '\u00b1',
  sup2: '\u00b2',
  sup3: '\u00b3',
  acute: '\u00b4',
  micro: '\u00b5',
  para: '\u00b6',
  middot: '\u00b7',
  centerdot: '\u00b7',
  CenterDot: '\u00b7',
  cedil: '\u00b8',
  sup1: '\u00b9',
  ordm: '\u00ba',
  raquo: '\u00bb',
  frac14: '\u00bc',
  frac12: '\u00bd',
  half: '\u00bd',
  frac34: '\u00be',
  iquest: '\u00bf',

  // Latin-1 uppercase letters (U+00C0..U+00DE)
  Agrave: '\u00c0',
  Aacute: '\u00c1',
  Acirc: '\u00c2',
  Atilde: '\u00c3',
  Auml: '\u00c4',
  Aring: '\u00c5',
  angst: '\u00c5',
  AElig: '\u00c6',
  Ccedil: '\u00c7',
  Egrave: '\u00c8',
  Eacute: '\u00c9',
  Ecirc: '\u00ca',
  Euml: '\u00cb',
  Igrave: '\u00cc',
  Iacute: '\u00cd',
  Icirc: '\u00ce',
  Iuml: '\u00cf',
  ETH: '\u00d0',
  Ntilde: '\u00d1',
  Ograve: '\u00d2',
  Oacute: '\u00d3',
  Ocirc: '\u00d4',
  Otilde: '\u00d5',
  Ouml: '\u00d6',
  times: '\u00d7',
  Oslash: '\u00d8',
  Ugrave: '\u00d9',
  Uacute: '\u00da',
  Ucirc: '\u00db',
  Uuml: '\u00dc',
  Yacute: '\u00dd',
  THORN: '\u00de',
  szlig: '\u00df',

  // Latin-1 lowercase letters (U+00E0..U+00FF)
  agrave: '\u00e0',
  aacute: '\u00e1',
  acirc: '\u00e2',
  atilde: '\u00e3',
  auml: '\u00e4',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  egrave: '\u00e8',
  eacute: '\u00e9',
  ecirc: '\u00ea',
  euml: '\u00eb',
  igrave: '\u00ec',
  iacute: '\u00ed',
  icirc: '\u00ee',
  iuml: '\u00ef',
  eth: '\u00f0',
  ntilde: '\u00f1',
  ograve: '\u00f2',
  oacute: '\u00f3',
  ocirc: '\u00f4',
  otilde: '\u00f5',
  ouml: '\u00f6',
  divide: '\u00f7',
  div: '\u00f7',
  oslash: '\u00f8',
  ugrave: '\u00f9',
  uacute: '\u00fa',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  thorn: '\u00fe',
  yuml: '\u00ff',

  // Latin Extended-A / Extended-B / Spacing Modifier Letters
  Aogon: '\u0104',
  aogon: '\u0105',
  Cacute: '\u0106',
  cacute: '\u0107',
  Ccaron: '\u010c',
  ccaron: '\u010d',
  Dcaron: '\u010e',
  dcaron: '\u010f',
  Dstrok: '\u0110',
  dstrok: '\u0111',
  Eogon: '\u0118',
  eogon: '\u0119',
  Ecaron: '\u011a',
  ecaron: '\u011b',
  Gbreve: '\u011e',
  gbreve: '\u011f',
  Idot: '\u0130',
  inodot: '\u0131',
  imath: '\u0131',
  Lstrok: '\u0141',
  lstrok: '\u0142',
  Nacute: '\u0143',
  nacute: '\u0144',
  Ncaron: '\u0147',
  ncaron: '\u0148',
  OElig: '\u0152',
  oelig: '\u0153',
  Rcaron: '\u0158',
  rcaron: '\u0159',
  Sacute: '\u015a',
  sacute: '\u015b',
  Scedil: '\u015e',
  scedil: '\u015f',
  Scaron: '\u0160',
  scaron: '\u0161',
  Tcaron: '\u0164',
  tcaron: '\u0165',
  Uring: '\u016e',
  uring: '\u016f',
  Yuml: '\u0178',
  Zacute: '\u0179',
  zacute: '\u017a',
  Zdot: '\u017b',
  zdot: '\u017c',
  Zcaron: '\u017d',
  zcaron: '\u017e',
  fnof: '\u0192',
  circ: '\u02c6',
  caron: '\u02c7',
  tilde: '\u02dc',

  // Greek alphabet (uppercase & lowercase)
  Alpha: '\u0391',
  Beta: '\u0392',
  Gamma: '\u0393',
  Delta: '\u0394',
  Epsilon: '\u0395',
  Zeta: '\u0396',
  Eta: '\u0397',
  Theta: '\u0398',
  Iota: '\u0399',
  Kappa: '\u039a',
  Lambda: '\u039b',
  Mu: '\u039c',
  Nu: '\u039d',
  Xi: '\u039e',
  Omicron: '\u039f',
  Pi: '\u03a0',
  Rho: '\u03a1',
  Sigma: '\u03a3',
  Tau: '\u03a4',
  Upsilon: '\u03a5',
  Phi: '\u03a6',
  Chi: '\u03a7',
  Psi: '\u03a8',
  Omega: '\u03a9',
  ohm: '\u03a9',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  epsilon: '\u03b5',
  epsi: '\u03b5',
  zeta: '\u03b6',
  eta: '\u03b7',
  theta: '\u03b8',
  iota: '\u03b9',
  kappa: '\u03ba',
  lambda: '\u03bb',
  mu: '\u03bc',
  nu: '\u03bd',
  xi: '\u03be',
  omicron: '\u03bf',
  pi: '\u03c0',
  rho: '\u03c1',
  sigmaf: '\u03c2',
  varsigma: '\u03c2',
  sigmav: '\u03c2',
  sigma: '\u03c3',
  tau: '\u03c4',
  upsilon: '\u03c5',
  upsi: '\u03c5',
  phi: '\u03c6',
  chi: '\u03c7',
  psi: '\u03c8',
  omega: '\u03c9',
  thetasym: '\u03d1',
  vartheta: '\u03d1',
  thetav: '\u03d1',
  upsih: '\u03d2',
  Upsi: '\u03d2',
  varphi: '\u03d5',
  phiv: '\u03d5',
  piv: '\u03d6',
  varpi: '\u03d6',
  varepsilon: '\u03f5',
  epsiv: '\u03f5',
  varrho: '\u03f1',
  rhov: '\u03f1',

  // General punctuation, spaces, dashes, quotes, format chars
  ensp: '\u2002',
  emsp: '\u2003',
  emsp13: '\u2004',
  emsp14: '\u2005',
  numsp: '\u2007',
  puncsp: '\u2008',
  thinsp: '\u2009',
  ThinSpace: '\u2009',
  hairsp: '\u200a',
  VeryThinSpace: '\u200a',
  ZeroWidthSpace: '\u200b',
  NegativeVeryThinSpace: '\u200b',
  NegativeThinSpace: '\u200b',
  NegativeMediumSpace: '\u200b',
  NegativeThickSpace: '\u200b',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
  hyphen: '\u2010',
  dash: '\u2010',
  ndash: '\u2013',
  mdash: '\u2014',
  horbar: '\u2015',
  Verbar: '\u2016',
  Vert: '\u2016',
  lsquo: '\u2018',
  OpenCurlyQuote: '\u2018',
  rsquo: '\u2019',
  rsquor: '\u2019',
  CloseCurlyQuote: '\u2019',
  sbquo: '\u201a',
  lsquor: '\u201a',
  ldquo: '\u201c',
  OpenCurlyDoubleQuote: '\u201c',
  rdquo: '\u201d',
  rdquor: '\u201d',
  CloseCurlyDoubleQuote: '\u201d',
  bdquo: '\u201e',
  ldquor: '\u201e',
  dagger: '\u2020',
  Dagger: '\u2021',
  ddagger: '\u2021',
  bull: '\u2022',
  bullet: '\u2022',
  nldr: '\u2025',
  hellip: '\u2026',
  mldr: '\u2026',
  permil: '\u2030',
  pertenk: '\u2031',
  prime: '\u2032',
  Prime: '\u2033',
  tprime: '\u2034',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  oline: '\u203e',
  OverBar: '\u203e',
  caret: '\u2041',
  hybull: '\u2043',
  frasl: '\u2044',
  MediumSpace: '\u205f',
  ThickSpace: '\u205f\u200a',
  NoBreak: '\u2060',

  // Currency, letterlike, fractions & commercial symbols
  euro: '\u20ac',
  incare: '\u2105',
  hbar: '\u210f',
  planckh: '\u210e',
  image: '\u2111',
  Im: '\u2111',
  imagpart: '\u2111',
  ell: '\u2113',
  numero: '\u2116',
  copysr: '\u2117',
  weierp: '\u2118',
  wp: '\u2118',
  real: '\u211c',
  Re: '\u211c',
  realpart: '\u211c',
  rx: '\u211e',
  trade: '\u2122',
  TRADE: '\u2122',
  mho: '\u2127',
  alefsym: '\u2135',
  aleph: '\u2135',
  beth: '\u2136',
  gimel: '\u2137',
  daleth: '\u2138',
  frac13: '\u2153',
  frac23: '\u2154',
  frac15: '\u2155',
  frac25: '\u2156',
  frac35: '\u2157',
  frac45: '\u2158',
  frac16: '\u2159',
  frac56: '\u215a',
  frac18: '\u215b',
  frac38: '\u215c',
  frac58: '\u215d',
  frac78: '\u215e',

  // Arrows
  larr: '\u2190',
  leftarrow: '\u2190',
  LeftArrow: '\u2190',
  uarr: '\u2191',
  uparrow: '\u2191',
  UpArrow: '\u2191',
  rarr: '\u2192',
  rightarrow: '\u2192',
  RightArrow: '\u2192',
  darr: '\u2193',
  downarrow: '\u2193',
  DownArrow: '\u2193',
  harr: '\u2194',
  leftrightarrow: '\u2194',
  LeftRightArrow: '\u2194',
  varr: '\u2195',
  updownarrow: '\u2195',
  nwarr: '\u2196',
  nearr: '\u2197',
  searr: '\u2198',
  swarr: '\u2199',
  mapsto: '\u21a6',
  crarr: '\u21b5',
  lArr: '\u21d0',
  Leftarrow: '\u21d0',
  DoubleLeftArrow: '\u21d0',
  uArr: '\u21d1',
  Uparrow: '\u21d1',
  DoubleUpArrow: '\u21d1',
  rArr: '\u21d2',
  Rightarrow: '\u21d2',
  DoubleRightArrow: '\u21d2',
  dArr: '\u21d3',
  Downarrow: '\u21d3',
  DoubleDownArrow: '\u21d3',
  hArr: '\u21d4',
  Leftrightarrow: '\u21d4',
  iff: '\u21d4',
  DoubleLeftRightArrow: '\u21d4',
  longleftarrow: '\u27f5',
  longrightarrow: '\u27f6',
  longleftrightarrow: '\u27f7',

  // Mathematical operators & relations
  forall: '\u2200',
  ForAll: '\u2200',
  comp: '\u2201',
  part: '\u2202',
  PartialD: '\u2202',
  exist: '\u2203',
  Exists: '\u2203',
  nexist: '\u2204',
  empty: '\u2205',
  emptyset: '\u2205',
  emptyv: '\u2205',
  varnothing: '\u2205',
  nabla: '\u2207',
  Del: '\u2207',
  isin: '\u2208',
  in: '\u2208',
  Element: '\u2208',
  notin: '\u2209',
  NotElement: '\u2209',
  ni: '\u220b',
  niv: '\u220b',
  ReverseElement: '\u220b',
  notni: '\u220c',
  prod: '\u220f',
  Product: '\u220f',
  coprod: '\u2210',
  sum: '\u2211',
  Sum: '\u2211',
  minus: '\u2212',
  mp: '\u2213',
  mnplus: '\u2213',
  MinusPlus: '\u2213',
  plusdo: '\u2214',
  setmn: '\u2216',
  setminus: '\u2216',
  lowast: '\u2217',
  compfn: '\u2218',
  radic: '\u221a',
  Sqrt: '\u221a',
  prop: '\u221d',
  propto: '\u221d',
  Proportional: '\u221d',
  infin: '\u221e',
  ang: '\u2220',
  angle: '\u2220',
  mid: '\u2223',
  nmid: '\u2224',
  par: '\u2225',
  parallel: '\u2225',
  npar: '\u2226',
  and: '\u2227',
  wedge: '\u2227',
  or: '\u2228',
  vee: '\u2228',
  cap: '\u2229',
  cup: '\u222a',
  int: '\u222b',
  Integral: '\u222b',
  Int: '\u222c',
  tint: '\u222d',
  conint: '\u222e',
  oint: '\u222e',
  there4: '\u2234',
  therefore: '\u2234',
  Therefore: '\u2234',
  becaus: '\u2235',
  because: '\u2235',
  Because: '\u2235',
  ratio: '\u2236',
  Colon: '\u2237',
  sim: '\u223c',
  Tilde: '\u223c',
  nsim: '\u2241',
  cong: '\u2245',
  TildeFullEqual: '\u2245',
  ncong: '\u2247',
  asymp: '\u2248',
  ap: '\u2248',
  approx: '\u2248',
  TildeTilde: '\u2248',
  nap: '\u2249',
  ne: '\u2260',
  NotEqual: '\u2260',
  equiv: '\u2261',
  Congruent: '\u2261',
  nequiv: '\u2262',
  le: '\u2264',
  leq: '\u2264',
  ge: '\u2265',
  geq: '\u2265',
  GreaterEqual: '\u2265',
  ll: '\u226a',
  gg: '\u226b',
  nlt: '\u226e',
  ngt: '\u226f',
  nle: '\u2270',
  nge: '\u2271',
  sub: '\u2282',
  subset: '\u2282',
  sup: '\u2283',
  supset: '\u2283',
  nsub: '\u2284',
  nsup: '\u2285',
  sube: '\u2286',
  subseteq: '\u2286',
  supe: '\u2287',
  supseteq: '\u2287',
  nsube: '\u2288',
  nsupe: '\u2289',
  oplus: '\u2295',
  ominus: '\u2296',
  otimes: '\u2297',
  odot: '\u2299',
  vdash: '\u22a2',
  dashv: '\u22a3',
  top: '\u22a4',
  perp: '\u22a5',
  bot: '\u22a5',
  bottom: '\u22a5',
  models: '\u22a7',
  vDash: '\u22a8',
  sdot: '\u22c5',
  cdot: '\u22c5',
  Star: '\u22c6',
  bowtie: '\u22c8',
  vellip: '\u22ee',
  ctdot: '\u22ef',
  utdot: '\u22f0',
  dtdot: '\u22f1',
  lceil: '\u2308',
  rceil: '\u2309',
  lfloor: '\u230a',
  rfloor: '\u230b',
  lang: '\u27e8',
  langle: '\u27e8',
  LeftAngleBracket: '\u27e8',
  rang: '\u27e9',
  rangle: '\u27e9',
  RightAngleBracket: '\u27e9',

  // Geometric, box drawing, card suits & miscellaneous symbols
  loz: '\u25ca',
  lozenge: '\u25ca',
  boxh: '\u2500',
  boxv: '\u2502',
  boxdr: '\u250c',
  boxdl: '\u2510',
  boxur: '\u2514',
  boxul: '\u2518',
  boxvr: '\u251c',
  boxvl: '\u2524',
  boxhd: '\u252c',
  boxhu: '\u2534',
  boxvh: '\u253c',
  uhblk: '\u2580',
  lhblk: '\u2584',
  block: '\u2588',
  blk14: '\u2591',
  blk12: '\u2592',
  blk34: '\u2593',
  squ: '\u25a1',
  square: '\u25a1',
  squf: '\u25aa',
  rect: '\u25ad',
  utrif: '\u25b4',
  utri: '\u25b5',
  rtrif: '\u25b8',
  rtri: '\u25b9',
  dtrif: '\u25be',
  dtri: '\u25bf',
  ltrif: '\u25c2',
  ltri: '\u25c3',
  cir: '\u25cb',
  starf: '\u2605',
  bigstar: '\u2605',
  star: '\u2606',
  phone: '\u260e',
  female: '\u2640',
  male: '\u2642',
  spades: '\u2660',
  spadesuit: '\u2660',
  clubs: '\u2663',
  clubsuit: '\u2663',
  hearts: '\u2665',
  heartsuit: '\u2665',
  diams: '\u2666',
  diamondsuit: '\u2666',
  sung: '\u266a',
  flat: '\u266d',
  natur: '\u266e',
  natural: '\u266e',
  sharp: '\u266f',
  check: '\u2713',
  checkmark: '\u2713',
  cross: '\u2717',
  malt: '\u2720',
  sext: '\u2736',

  // Common HTML5 ligatures & multi-codepoint entities
  fflig: '\ufb00',
  filig: '\ufb01',
  fllig: '\ufb02',
  ffilig: '\ufb03',
  ffllig: '\ufb04',
  fjlig: 'fj',
  NotEqualTilde: '\u2242\u0338',
  nvlt: '<\u20d2',
  nvgt: '>\u20d2',
  acE: '\u223e\u0333',
})

const MAX_ENTITY_NAME_LEN = 32

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function isAsciiHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  )
}

function isAsciiAlphaNum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  )
}

/**
 * Decode a numeric Unicode code point according to WHATWG HTML5 Section 13.2.5.80:
 * - 0x00, surrogates (0xD800..0xDFFF), and > 0x10FFFF map to U+FFFD
 * - 0x80..0x9F map through the Windows-1252 replacement table
 * - Valid code points (including astral > 0xFFFF) decode via String.fromCodePoint
 */
export function decodeNumericEntity(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return '\ufffd'
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return '\ufffd'
  }
  const win1252 = WINDOWS_1252_NUMERIC_MAP[codePoint]
  if (win1252 !== undefined) {
    return String.fromCodePoint(win1252)
  }
  return String.fromCodePoint(codePoint)
}

/**
 * Look up a named HTML5 entity (without leading `&` or trailing `;`).
 * When `requireSemicolon` is false, only legacy HTML4/HTML5 entities are returned.
 */
export function lookupNamedEntity(
  name: string,
  options: { requireSemicolon?: boolean } = {},
): string | undefined {
  if (!name) return undefined
  if (options.requireSemicolon === false) {
    if (!HTML5_LEGACY_NAMED_ENTITIES.has(name)) return undefined
  }
  if (Object.prototype.hasOwnProperty.call(HTML5_NAMED_ENTITIES, name)) {
    return HTML5_NAMED_ENTITIES[name]
  }
  return undefined
}

/**
 * Decode HTML5 named and numeric (decimal and hexadecimal) character references in a
 * single pass (never double-decoding `&amp;lt;` into `<`).
 */
export function decodeHtmlEntities(
  input: string,
  options: DecodeHtmlEntitiesOptions = {},
): string {
  if (!input) return input
  let ampIdx = input.indexOf('&')
  if (ampIdx === -1) return input

  const attributeMode = options.attributeMode === true
  const len = input.length
  let out = ''
  let lastPos = 0

  while (ampIdx !== -1) {
    const nextIdx = ampIdx + 1
    if (nextIdx >= len) break

    let decoded: string | undefined
    let endPos = nextIdx

    if (input.charCodeAt(nextIdx) === 0x23 /* '#' */) {
      const afterHash = nextIdx + 1
      if (afterHash < len) {
        const ch = input.charCodeAt(afterHash)
        if (ch === 0x78 /* 'x' */ || ch === 0x58 /* 'X' */) {
          let p = afterHash + 1
          let value = 0
          let digitCount = 0
          while (p < len && isAsciiHexDigit(input.charCodeAt(p))) {
            if (value <= 0x10ffff) {
              const d = input.charCodeAt(p)
              const hex =
                d <= 0x39 ? d - 0x30 : d <= 0x46 ? d - 0x41 + 10 : d - 0x61 + 10
              value = value * 16 + hex
            }
            digitCount++
            p++
          }
          if (digitCount > 0) {
            if (p < len && input.charCodeAt(p) === 0x3b /* ';' */) {
              p++
            }
            decoded = decodeNumericEntity(value)
            endPos = p
          }
        } else if (isAsciiDigit(ch)) {
          let p = afterHash
          let value = 0
          while (p < len && isAsciiDigit(input.charCodeAt(p))) {
            if (value <= 0x10ffff) {
              value = value * 10 + (input.charCodeAt(p) - 0x30)
            }
            p++
          }
          if (p < len && input.charCodeAt(p) === 0x3b /* ';' */) {
            p++
          }
          decoded = decodeNumericEntity(value)
          endPos = p
        }
      }
    } else {
      // Named character reference: scan ASCII alphanumerics up to MAX_ENTITY_NAME_LEN
      let p = nextIdx
      const maxEnd = Math.min(len, nextIdx + MAX_ENTITY_NAME_LEN)
      while (p < maxEnd && isAsciiAlphaNum(input.charCodeAt(p))) {
        p++
      }
      if (p > nextIdx) {
        const name = input.slice(nextIdx, p)
        const hasSemi = p < len && input.charCodeAt(p) === 0x3b /* ';' */
        if (hasSemi) {
          const hit = lookupNamedEntity(name, { requireSemicolon: true })
          if (hit !== undefined) {
            decoded = hit
            endPos = p + 1
          }
        } else {
          // Semicolon-less legacy named entity:
          // In attribute mode, do not decode if followed by '=' (or alphanumeric, already excluded by scan).
          const nextCharCode = p < len ? input.charCodeAt(p) : -1
          const blockedByAttrRule =
            attributeMode && (nextCharCode === 0x3d /* '=' */ || isAsciiAlphaNum(nextCharCode))
          if (!blockedByAttrRule) {
            const hit = lookupNamedEntity(name, { requireSemicolon: false })
            if (hit !== undefined) {
              decoded = hit
              endPos = p
            }
          }
        }
      }
    }

    if (decoded !== undefined) {
      out += input.slice(lastPos, ampIdx) + decoded
      lastPos = endPos
      ampIdx = input.indexOf('&', lastPos)
    } else {
      ampIdx = input.indexOf('&', ampIdx + 1)
    }
  }

  if (lastPos === 0) return input
  return out + input.slice(lastPos)
}
