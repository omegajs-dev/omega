export default async ({ ctx, omega }) => {

  // Get url
  const url = omega.config?.brand?.url;

  // Log
  ctx.log('Route.main(): Executing route logic', url);

  // Redirect to brand URL
  return ctx.redirect(url);
};
