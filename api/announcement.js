// Reads the announcement banner's content from env vars, so it can be changed
// from the Vercel dashboard alone — no code edits, no redeploying by hand
// beyond the one click Vercel already requires to pick up a changed env var.
module.exports = async (req, res) => {
  const title = (process.env.ANNOUNCEMENT_TITLE || '').trim();
  const body = (process.env.ANNOUNCEMENT_BODY || '').trim();
  res.status(200).json({ title, body });
};
