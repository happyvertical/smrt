// The app's own database for `smrt db:migrate` / `smrt db:status`: a scratch
// SQLite file inside the canary directory. An explicit project setting wins
// over any DATABASE_URL in the environment (smrt-cli "Database precedence").
export default {
  packages: {
    cli: {
      database: { type: 'sqlite', url: './canary.db' },
    },
  },
};
