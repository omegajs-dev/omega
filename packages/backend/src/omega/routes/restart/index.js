import jetpack from 'fs-jetpack';

export default async ({ ctx, user, analytics }) => {

  // Send analytics event
  analytics.event('restart', {});

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Log
  ctx.log('Restarting...');

  // Remove node_modules
  jetpack.remove('node_modules');

  // Perform delayed refresh to allow a successful response
  setTimeout(async function () {
    (await import('child_process')).exec('refresh', (error, stdout, stderr) => {
      // Quit the process if there is an error
      if (error || stderr) {
        console.log(`error: ${error ? error.message : stderr}`);
        return process.exit(1);
      }
    });
  }, 1000);

  // Return success
  return ctx.respond({success: true});
};
