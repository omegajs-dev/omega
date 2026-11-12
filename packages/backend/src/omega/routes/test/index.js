export default async ({ ctx, analytics }) => {

  // Send analytics event
  analytics.event('test', {});

  // Log
  ctx.log('Running test');
  ctx.log('ctx.request.body', ctx.request.body);
  ctx.log('ctx.request.query', ctx.request.query);
  ctx.log('ctx.request.headers', ctx.request.headers);
  ctx.log('ctx.request.data', ctx.request.data);
  ctx.log('ctx.data', ctx.data);

  // Return success
  return ctx.respond({timestamp: new Date().toISOString(), id: ctx.id});
};
