/**
 * Métodos de cobro por país: qué número pide cada uno, cómo se valida y qué documento identifica al titular.
 * El panel arma el formulario con esta lista (GET /admin/account-methods) y el API valida con la misma.
 */
export type AccountCountry = 'CO' | 'MX' | 'AR';

export interface AccountMethod {
  key: string;
  /** '*' = disponible en todos los países (p. ej. Binance); el país lo elige el operador. */
  country: AccountCountry | '*';
  label: string;
  numberLabel: string;
  placeholder: string;
  /** Regla sobre el valor ya limpio (sin espacios ni guiones). */
  pattern: string;
  hint: string;
  /** El número es una llave/alias (no solo dígitos): también se guarda como alias para reconocerlo en el comprobante. */
  keyLike?: boolean;
  /** Si el método agrupa varios bancos, el operador elige uno de esta lista. */
  banks?: readonly string[];
  /** Si aplica, el operador elige el tipo de cuenta (ahorros o corriente). */
  accountTypes?: readonly string[];
  /** Solo se pide la dirección: sin titular, documento ni alias. */
  walletOnly?: boolean;
}

const TYPES_CO = ['Ahorros', 'Corriente'];
const TYPES_AR = ['Caja de ahorro', 'Cuenta corriente'];

const BANKS_CO = [
  'Davivienda', 'Banco de Bogotá', 'BBVA Colombia', 'Banco de Occidente', 'Banco Popular', 'Banco AV Villas', 'Banco Caja Social',
  'Scotiabank Colpatria', 'Banco Agrario', 'Itaú', 'Banco GNB Sudameris', 'Banco Falabella', 'Banco Pichincha', 'Bancoomeva',
  'Banco Finandina', 'Banco Serfinanza', 'Banco W', 'Bancamía', 'Banco Mundo Mujer', 'Banco Coopcentral', 'Banco Santander Colombia',
  'Banco Unión', 'Nu Colombia', 'Lulo Bank', 'RappiPay', 'Ualá Colombia', 'Movii', 'Dale!', 'Otro',
];
const BANKS_MX = [
  'BBVA México', 'Banorte', 'Santander México', 'Banamex', 'HSBC México', 'Scotiabank México', 'Inbursa', 'Banco Azteca', 'BanCoppel',
  'Banregio', 'Banco del Bajío', 'Afirme', 'Nu México', 'Spin by OXXO', 'Hey Banco', 'Stori', 'Klar', 'Otro',
];
const BANKS_AR = [
  'Banco Nación', 'Banco Provincia', 'Banco Ciudad', 'Galicia', 'Santander Argentina', 'BBVA Argentina', 'Macro', 'ICBC', 'HSBC Argentina',
  'Credicoop', 'Patagonia', 'Supervielle', 'Comafi', 'Hipotecario', 'Banco del Sol', 'Brubank', 'Otro',
];

export interface CountryDoc {
  country: AccountCountry;
  name: string;
  docLabel: string;
  docPlaceholder: string;
  docPattern: string;
  aliasLabel: string;
}

export const ACCOUNT_COUNTRIES: readonly CountryDoc[] = [
  { country: 'CO', name: 'Colombia', docLabel: 'Cédula (CC) o NIT del titular', docPlaceholder: '1020304050', docPattern: '^\\d{6,12}$', aliasLabel: 'Nombre para reconocerla (ej. Nequi principal)' },
  { country: 'MX', name: 'México', docLabel: 'RFC del titular', docPlaceholder: 'CAPJ800101AB1', docPattern: '^[A-Za-zÑñ&]{3,4}\\d{6}[A-Za-z0-9]{3}$', aliasLabel: 'Nombre para reconocerla (ej. BBVA principal)' },
  { country: 'AR', name: 'Argentina', docLabel: 'CUIT / CUIL del titular', docPlaceholder: '20123456789', docPattern: '^\\d{11}$', aliasLabel: 'Alias de la cuenta (ej. juan.campos.mp)' },
];

export const ACCOUNT_METHODS: readonly AccountMethod[] = [
  { key: 'nequi', country: 'CO', label: 'Nequi', numberLabel: 'Celular Nequi', placeholder: '3001234567', pattern: '^3\\d{9}$', hint: 'El celular de 10 dígitos asociado a Nequi.' },
  { key: 'daviplata', country: 'CO', label: 'Daviplata', numberLabel: 'Celular Daviplata', placeholder: '3001234567', pattern: '^3\\d{9}$', hint: 'El celular de 10 dígitos asociado a Daviplata.' },
  { key: 'bancolombia', country: 'CO', label: 'Bancolombia', numberLabel: 'Número de cuenta', placeholder: '12345678901', pattern: '^\\d{11}$', hint: 'Cuenta de ahorros o corriente de 11 dígitos.', accountTypes: TYPES_CO },
  { key: 'breb', country: 'CO', label: 'Llave Bre-B', numberLabel: 'Llave', placeholder: '@tunombre, celular, cédula o correo', pattern: '^\\S{4,60}$', hint: 'La llave tal como la registraste en Bre-B.', keyLike: true },
  { key: 'banco_co', country: 'CO', label: 'Otro banco', numberLabel: 'Número de cuenta', placeholder: '000123456789', pattern: '^\\d{6,20}$', hint: 'Elige el banco y escribe el número de cuenta, sin guiones.', banks: BANKS_CO, accountTypes: TYPES_CO },
  { key: 'spei', country: 'MX', label: 'Transferencia SPEI', numberLabel: 'CLABE', placeholder: '012180001234567891', pattern: '^\\d{18}$', hint: 'La CLABE interbancaria de 18 dígitos.', banks: BANKS_MX },
  { key: 'tarjeta_mx', country: 'MX', label: 'Tarjeta de débito', numberLabel: 'Número de tarjeta', placeholder: '4152313412345678', pattern: '^\\d{16}$', hint: 'Los 16 dígitos de la tarjeta (para depósitos con tarjeta).' },
  { key: 'cvu', country: 'AR', label: 'CVU (otra billetera)', numberLabel: 'CVU', placeholder: '0000003100012345678901', pattern: '^\\d{22}$', hint: 'Ualá, Naranja X, Brubank, Lemon… 22 dígitos.' },
  { key: 'cbu', country: 'AR', label: 'CBU (banco)', numberLabel: 'CBU', placeholder: '0170099220000067797370', pattern: '^\\d{22}$', hint: 'La CBU de tu cuenta bancaria, 22 dígitos.', banks: BANKS_AR, accountTypes: TYPES_AR },
  { key: 'mercadopago', country: '*', label: 'Mercado Pago', numberLabel: 'CVU / CLABE / número de cuenta', placeholder: 'Argentina: CVU · México: CLABE', pattern: '^\\d{6,22}$', hint: 'En Mercado Pago: Tu perfil → Tus datos de cuenta (CVU en Argentina, CLABE en México). Pon tu alias abajo.' },
  { key: 'binance_pay', country: '*', label: 'Binance Pay', numberLabel: 'Pay ID de Binance', placeholder: '123456789', pattern: '^\\d{6,12}$', hint: 'En Binance: Pay → tu Pay ID (solo números).' },
  { key: 'binance_wallet', country: '*', label: 'Binance · USDT (TRC20)', numberLabel: 'Dirección de la billetera USDT (red TRON · TRC20)', placeholder: 'T…', pattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$', hint: 'En Binance: Billetera → Depositar → USDT → red TRON (TRC20). Copia la dirección (empieza por T).', keyLike: true, walletOnly: true },
];

export const accountMethod = (key: string | undefined) => ACCOUNT_METHODS.find((m) => m.key === key);

/** Limpia el número según el método: dígitos para cuentas, texto sin espacios para llaves. */
export function cleanAccountNumber(m: AccountMethod, raw: string): string {
  return m.keyLike ? raw.trim().replace(/\s+/g, '') : raw.replace(/[\s.-]/g, '');
}

/** Devuelve el error para mostrar, o null si los datos sirven. */
export function checkAccount(m: AccountMethod, number: string, doc?: string, country?: string, bankName?: string, accountType?: string): string | null {
  if (m.accountTypes && !(accountType && m.accountTypes.includes(accountType))) return 'Elige si la cuenta es de ahorros o corriente.';
  if (m.banks && !(bankName && m.banks.includes(bankName))) return 'Elige el banco de la lista.';
  if (!new RegExp(m.pattern).test(number)) return `${m.numberLabel} no es válido: ${m.hint}`;
  const c = ACCOUNT_COUNTRIES.find((x) => x.country === (m.country === '*' ? country : m.country));
  if (!c) return 'Elige el país de la cuenta.';
  if (doc && !new RegExp(c.docPattern).test(doc)) return `${c.docLabel} no es válido.`;
  return null;
}
