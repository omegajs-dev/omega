import powertools from 'node-powertools';

export default async ({ ctx, data }) => {

  // Optional delay
  if (data.delay > 0) {
    await powertools.wait(data.delay);
  }

  // Return based on status code
  if (data.status >= 200 && data.status <= 299) {
    return ctx.respond(data.response, { code: data.status });
  }

  if (data.status >= 400 && data.status <= 599) {
    return ctx.respond(data.response, { code: data.status });
  }

  // Default response
  return ctx.respond({ received: true });
};
