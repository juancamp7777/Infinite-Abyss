/**
 * Páginas legales del casino. {casino} se reemplaza por el nombre del operador y {licencia} por su licencia
 * (si no hay licencia configurada, el párrafo que la menciona se omite). Texto base: debe revisarlo el abogado del operador.
 */
export interface LegalSection {
  title: string;
  body: string[];
}

export interface LegalPage {
  slug: string;
  title: string;
  intro: string;
  sections: LegalSection[];
}

export const LEGAL_PAGES: LegalPage[] = [
  {
    slug: "acerca-de-nosotros",
    title: "Acerca de nosotros",
    intro: "{casino} es un casino en línea pensado para Latinoamérica: juegos de calidad, pagos locales y atención humana a cualquier hora.",
    sections: [
      {
        title: "Qué ofrecemos",
        body: [
          "Slots de los principales proveedores, juegos originales con resultados verificables (provably fair), mesas, torneos y jackpots.",
          "Recargas y retiros con los métodos que usas todos los días: transferencias, billeteras, PSE, tarjetas y USDT.",
        ],
      },
      {
        title: "Nuestro compromiso",
        body: [
          "Pagos claros y rápidos, soporte 24/7 por chat y Telegram, protección de tus datos y herramientas reales de juego responsable.",
          "Cada recarga se verifica contra el pago real y cada retiro pasa por controles de seguridad antes de enviarse.",
        ],
      },
      {
        title: "Licencia y cumplimiento",
        body: ["{casino} opera bajo la siguiente licencia de juego: {licencia}.", "Cumplimos las normas de prevención de lavado de activos, protección de datos y juego responsable aplicables a nuestra operación."],
      },
      { title: "Contacto", body: ["Escríbenos por el chat de soporte del sitio o por nuestro Telegram oficial. Nunca te pediremos tu contraseña."] },
    ],
  },
  {
    slug: "kyc-aml",
    title: "KYC y AML",
    intro: "Para proteger a los jugadores y al casino verificamos la identidad de nuestros clientes (KYC, \"conoce a tu cliente\") y aplicamos controles de prevención del lavado de activos y la financiación del terrorismo (AML).",
    sections: [
      {
        title: "Cuándo pedimos verificación",
        body: [
          "Antes del primer retiro, cuando los montos depositados o retirados superan los umbrales internos, ante actividad inusual o cuando cambias tus datos o medios de pago.",
          "Mientras la verificación esté pendiente podemos retener retiros. Los depósitos y el juego pueden continuar salvo que detectemos un riesgo.",
        ],
      },
      {
        title: "Documentos",
        body: [
          "Documento de identidad vigente con foto (cédula de ciudadanía, INE, DNI o pasaporte).",
          "Una selfie sosteniendo el documento, para confirmar que eres tú.",
          "Cuando sea necesario: comprobante de domicilio de los últimos tres meses y prueba de titularidad del medio de pago.",
        ],
      },
      {
        title: "Titularidad de los pagos",
        body: [
          "Los depósitos deben hacerse desde cuentas a tu nombre y los retiros se envían solo a cuentas a tu nombre.",
          "No aceptamos pagos de terceros. Un depósito de una cuenta ajena puede devolverse a su origen y la cuenta del jugador quedar en revisión.",
        ],
      },
      {
        title: "Monitoreo y reporte",
        body: [
          "Revisamos las transacciones de forma continua. Ante operaciones sospechosas podemos pedir información adicional, suspender la cuenta, retener fondos y reportar a la autoridad competente, como exige la ley, sin aviso previo al jugador.",
          "No aceptamos como clientes a personas incluidas en listas restrictivas nacionales o internacionales. Las personas expuestas políticamente pasan por una revisión reforzada.",
        ],
      },
      { title: "Conservación", body: ["Guardamos los registros de identidad y transacciones durante el plazo que exige la normativa aplicable, con acceso restringido y cifrado."] },
    ],
  },
  {
    slug: "terminos-y-condiciones",
    title: "Términos y condiciones",
    intro: "Estos términos regulan el uso de {casino}. Al registrarte o jugar aceptas cumplirlos. Léelos con atención.",
    sections: [
      {
        title: "1. Elegibilidad",
        body: [
          "Debes tener al menos 18 años, o la mayoría de edad de tu país si es mayor, y estar en un lugar donde el juego en línea sea legal para ti.",
          "Solo se permite una cuenta por persona, hogar, dispositivo y medio de pago. Las cuentas duplicadas pueden cerrarse y sus ganancias anularse.",
        ],
      },
      {
        title: "2. Tu cuenta",
        body: [
          "Los datos de registro deben ser verdaderos y estar actualizados. Eres responsable de mantener segura tu contraseña y de toda actividad hecha con tu cuenta.",
          "Si sospechas que alguien entró a tu cuenta, avísanos de inmediato por el chat de soporte.",
        ],
      },
      {
        title: "3. Depósitos",
        body: [
          "Puedes recargar con los métodos que aparecen en la caja. Cada método puede tener montos mínimos y máximos.",
          "El saldo se acredita cuando el pago se confirma. En recargas por transferencia, el comprobante se verifica contra el pago real; un comprobante alterado o ajeno se rechaza y la cuenta puede suspenderse.",
          "Los depósitos en USDT se acreditan en la moneda de tu cuenta a la tasa vigente publicada por el casino al momento de la confirmación.",
        ],
      },
      {
        title: "4. Retiros",
        body: [
          "Para retirar debes tener tu identidad verificada (ver KYC y AML) y haber cumplido los requisitos de los bonos activos.",
          "Los retiros se envían a una cuenta a tu nombre. Los tiempos dependen del método y de las revisiones de seguridad.",
          "Podemos rechazar o retener un retiro si detectamos incumplimiento de estos términos, fraude o un requerimiento legal.",
        ],
      },
      {
        title: "5. Bonos y promociones",
        body: [
          "Cada bono tiene sus propias condiciones (monto, vigencia y requisito de apuesta), que se informan al otorgarlo.",
          "El saldo de bono no es retirable hasta cumplir su requisito de apuesta. El abuso de promociones, las cuentas múltiples o las apuestas coordinadas anulan el bono y sus ganancias.",
        ],
      },
      {
        title: "6. Juegos y resultados",
        body: [
          "Los resultados los determina un generador de números aleatorios certificado o, en los juegos originales, un sistema verificable (provably fair).",
          "Ante una falla técnica, las jugadas afectadas se anulan y las apuestas se devuelven. Los registros del servidor prevalecen sobre lo que se vea en pantalla.",
        ],
      },
      {
        title: "7. Conductas prohibidas",
        body: [
          "Está prohibido el fraude, el uso de medios de pago ajenos o robados, los bots o programas automáticos, la colusión entre jugadores, aprovechar errores del sistema y cualquier operación de lavado de activos.",
          "Si detectamos estas conductas podemos cerrar la cuenta, anular ganancias y reportar a las autoridades.",
        ],
      },
      {
        title: "8. Suspensión, cierre e inactividad",
        body: [
          "Puedes cerrar tu cuenta cuando quieras desde el soporte. Si la cerramos nosotros sin que haya incumplimiento, te devolveremos el saldo retirable.",
          "Las cuentas sin actividad por un período prolongado pueden quedar inactivas; podrás reactivarlas contactando al soporte.",
        ],
      },
      {
        title: "9. Responsabilidad",
        body: [
          "El juego implica riesgo de pérdida. {casino} no responde por pérdidas derivadas del juego, por fallas de conexión del jugador ni por el uso indebido de su cuenta por terceros cuando la contraseña no se protegió.",
          "Todo el contenido del sitio (marcas, juegos, diseño) pertenece a {casino} o a sus proveedores y no puede usarse sin autorización.",
        ],
      },
      {
        title: "10. Licencia y ley aplicable",
        body: ["{casino} opera bajo la licencia {licencia}.", "Las reclamaciones se presentan primero por el chat de soporte. Si no quedas conforme, puedes acudir a la autoridad competente según la ley aplicable a la licencia."],
      },
      { title: "11. Cambios", body: ["Podemos actualizar estos términos. Te avisaremos de los cambios importantes y la versión vigente siempre estará publicada en esta página."] },
    ],
  },
  {
    slug: "juego-responsable",
    title: "Juego responsable",
    intro: "Jugar debe ser entretenimiento, no una forma de ganar dinero ni de resolver problemas. En {casino} te damos herramientas para mantener el control.",
    sections: [
      {
        title: "Consejos",
        body: [
          "Decide antes de jugar cuánto tiempo y dinero vas a dedicar, y respétalo.",
          "Juega solo con dinero que puedas permitirte perder. Nunca persigas las pérdidas ni juegues con dinero prestado.",
          "Haz pausas y no juegues bajo el efecto del alcohol, cansado o con emociones fuertes.",
        ],
      },
      {
        title: "Señales de alerta",
        body: ["Gastar más de lo planeado, mentir sobre el juego, descuidar el trabajo, los estudios o la familia, o sentir ansiedad cuando no juegas."],
      },
      {
        title: "Herramientas en tu cuenta",
        body: [
          "Desde Mi cuenta puedes fijar límites de depósito diarios, semanales o mensuales.",
          "También puedes pedir una pausa o la autoexclusión: durante ese tiempo no podrás jugar ni recibirás publicidad.",
        ],
      },
      { title: "Menores de edad", body: ["El juego está prohibido para menores de 18 años. Verificamos la edad y cerramos cualquier cuenta de un menor."] },
      { title: "Busca ayuda", body: ["Si sientes que el juego dejó de ser diversión, habla con alguien de confianza y busca apoyo profesional. Nuestro equipo de soporte también puede orientarte y aplicar una autoexclusión de inmediato."] },
    ],
  },
  {
    slug: "politica-antispam",
    title: "Política antispam",
    intro: "En {casino} solo te escribimos si nos diste permiso, y siempre puedes dejar de recibir mensajes.",
    sections: [
      {
        title: "Qué te enviamos",
        body: [
          "Mensajes de servicio, necesarios para tu cuenta: confirmaciones de recargas y retiros, seguridad y cambios en los términos.",
          "Publicidad (bonos, torneos, novedades), solo si aceptaste recibirla al registrarte o al activar las notificaciones.",
        ],
      },
      {
        title: "Cómo dejar de recibirlos",
        body: ["Desactiva las notificaciones en Mi cuenta o en tu navegador, usa el enlace de baja de cada correo o escríbenos por el chat. Los mensajes de servicio seguirán llegando mientras tengas la cuenta activa."],
      },
      {
        title: "Nuestro compromiso",
        body: [
          "No compramos ni vendemos bases de datos y no enviamos publicidad a quien no la aceptó, a menores de edad ni a personas autoexcluidas.",
          "Nunca te pediremos tu contraseña ni códigos de verificación por mensaje. Si recibes un mensaje así a nuestro nombre, repórtalo al soporte.",
        ],
      },
    ],
  },
  {
    slug: "politica-de-reembolso",
    title: "Política de reembolso",
    intro: "Así manejamos los reembolsos de depósitos en {casino}.",
    sections: [
      {
        title: "Depósitos usados",
        body: ["El saldo usado en apuestas no es reembolsable: el resultado de cada jugada es definitivo."],
      },
      {
        title: "Depósitos sin usar",
        body: [
          "Si recargaste por error y no has jugado ese saldo, escríbenos por el chat de soporte dentro de las 72 horas siguientes. Revisaremos el caso y, si procede, devolveremos el dinero al mismo medio y a la misma cuenta de origen.",
          "Los costos o comisiones que cobren bancos o pasarelas por la devolución pueden descontarse del monto.",
        ],
      },
      {
        title: "Cobros duplicados o no acreditados",
        body: ["Si un pago se cobró dos veces o no se acreditó, envíanos el comprobante por el chat. Lo verificamos contra el pago real y lo acreditamos o devolvemos."],
      },
      {
        title: "Bonos y contracargos",
        body: [
          "Los bonos y promociones no son reembolsables ni canjeables por dinero.",
          "Iniciar un contracargo o desconocer un pago ya acreditado puede suspender la cuenta mientras se aclara el caso.",
        ],
      },
    ],
  },
  {
    slug: "privacidad",
    title: "Política de privacidad",
    intro: "En {casino} tratamos tus datos personales con cuidado y solo para lo necesario.",
    sections: [
      {
        title: "Qué datos recolectamos",
        body: ["Datos de registro (correo, nombre, fecha de nacimiento), datos de verificación de identidad, historial de transacciones y de juego, comunicaciones con soporte y datos técnicos del dispositivo (IP, navegador)."],
      },
      {
        title: "Para qué los usamos",
        body: [
          "Para operar tu cuenta, procesar pagos, verificar tu identidad y edad, prevenir fraude y lavado de activos, dar soporte y cumplir obligaciones legales.",
          "Para enviarte publicidad solo si lo autorizaste.",
        ],
      },
      {
        title: "Con quién los compartimos",
        body: ["Con proveedores que nos ayudan a operar (pagos, verificación, hosting), bajo contratos de confidencialidad, y con autoridades cuando la ley lo exige. Nunca vendemos tus datos."],
      },
      {
        title: "Seguridad y conservación",
        body: ["Usamos cifrado y accesos restringidos. Conservamos los datos mientras tengas la cuenta y luego durante el plazo que exige la ley."],
      },
      {
        title: "Tus derechos",
        body: ["Puedes conocer, actualizar, rectificar y pedir la eliminación de tus datos, y retirar tu autorización de publicidad, según la ley de protección de datos de tu país. Escríbenos por el chat de soporte."],
      },
      { title: "Cookies y notificaciones", body: ["Usamos cookies necesarias para que el sitio funcione y recordar tus preferencias. Las notificaciones push solo se activan si das permiso en tu navegador."] },
    ],
  },
];

/** Enlaces de la columna "Recursos" del pie de página. */
export const LEGAL_LINKS = LEGAL_PAGES.map((p) => ({ href: `/legal/${p.slug}`, label: p.title }));

export const legalPage = (slug: string) => LEGAL_PAGES.find((p) => p.slug === slug);

/** Reemplaza los datos del casino; descarta los párrafos que mencionan una licencia que no está configurada. */
export function fillLegal(text: string, v: { casino: string; licencia?: string }): string | null {
  if (text.includes("{licencia}") && !v.licencia) return null;
  return text.replaceAll("{casino}", v.casino).replaceAll("{licencia}", v.licencia ?? "");
}
