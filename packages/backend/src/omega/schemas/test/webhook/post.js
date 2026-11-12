export default() => ({
  delay: { type: 'number', default: 0 },
  status: { type: 'number', default: 200 },
  response: { type: ['object', 'string'], default: {} },
});
