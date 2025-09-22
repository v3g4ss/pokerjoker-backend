require('dotenv').config(); // .env laden

const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV || 'development',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  SMTP_HOST: process.env.SMTP_HOST || '127.0.0.1',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '1025', 10),
  SMTP_SECURE: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  CONTACT_RECEIVER: process.env.CONTACT_RECEIVER || '',
};

module.exports = env;
