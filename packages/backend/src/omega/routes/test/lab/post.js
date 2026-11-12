export default async ({ ctx, user, data }) => {

  // Check admin
  if (!user.roles.admin) {
    ctx.log('User is not admin');
  }

  // Example: Send notification (demonstrates calling another @omega.js/backend endpoint)
  const url = 'https://itwcreativeworks.com';
  const title = 'https://itwcreativeworks.com';
  const icon = 'https://cdn.itwcreativeworks.com/assets/itw-creative-works/images/socials/itw-creative-works-brandmark-square-black-1024x1024.png?cb=1651834176';

  // For now, just return success - the lab is a testing sandbox
  ctx.log('Lab test executed', { url, title, icon });

  return ctx.respond({ success: true });
};
