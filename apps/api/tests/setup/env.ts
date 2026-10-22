// Valores de PRUEBA (no reales) inyectados solo en el entorno de tests, nunca en src.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://nymfo_test:nymfo_test@localhost:5433/nymfo_test?schema=public';
process.env.JWT_ACCESS_SECRET ||= 'test-only-jwt-access-0123456789abcdef-xx';
process.env.PASSIMPAY_PLATFORM_ID ||= '1234';
process.env.PASSIMPAY_API_KEY ||= 'test-passimpay-api-key';
process.env.WOMPI_PUBLIC_KEY ||= 'pub_test_dummy';
process.env.WOMPI_PRIVATE_KEY ||= 'prv_test_dummy';
process.env.WOMPI_EVENTS_SECRET ||= 'test-wompi-events-key';
process.env.WOMPI_INTEGRITY_SECRET ||= 'test-wompi-integrity-key';
process.env.PUBLIC_API_URL ||= 'http://localhost:4000';
process.env.PUBLIC_WEB_URL ||= 'http://localhost:3000';
