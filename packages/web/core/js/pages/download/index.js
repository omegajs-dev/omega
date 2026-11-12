/**
 * Download Page JavaScript
 */

// Libraries
import { FormManager } from '@omega.js/client/modules/form-manager.js';
import fetch from 'wonderful-fetch';
import omega from '@omega.js/web/runtime';
import { WAKEUP_ROUTE } from '@omega.js/client/modules/request.js';
import { event } from '__main_assets__/js/libs/analytics.js';

/* @dev-only:start */
// The page's dev control lives in the dev palette, not on window (#234, #342).
// The import is inside the block, so production strips it with the section.
import { registerDevSection } from '__main_assets__/js/core/dev-sections.js';
/* @dev-only:end */

// Module
export default () => {
  return new Promise(async function (resolve) {
    // Initialize when DOM is ready
    await omega.dom.ready();

    setupPlatformDetection();
    setupDownloadTracking();
    setupCopyButtons();
    setupMobileEmailForms();
    setupAutoDownload();

    /* @dev-only:start */
    // The onboarding walkthrough was `window.showDownloadModal(platform)`, a
    // console helper that also shipped to production. The palette is the one
    // home for it now, and it only exists in a dev build.
    if (omega.isDevelopment()) {
      registerDevSection('download', {
        title: 'Download',
        buildNode: buildDownloadDevSection,
      });
    }
    /* @dev-only:end */

    // Resolve after initialization
    return resolve();
  });
};

/* @dev-only:start */
/**
 * The palette's Download section: pick a platform the modal actually carries
 * instructions for, and open its walkthrough. The options come from the modal
 * in the page, so the list is whatever this brand ships.
 */
function buildDownloadDevSection(doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'omega-devbar__fields';

  const select = doc.createElement('select');
  select.className = 'omega-devbar__select';
  select.setAttribute('aria-label', 'Onboarding platform');
  document.querySelectorAll('#onboardingModal .platform-instructions[data-platform]').forEach(($pane) => {
    const option = doc.createElement('option');
    option.value = $pane.dataset.platform;
    option.textContent = $pane.dataset.platform;
    select.appendChild(option);
  });

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'omega-devbar__btn';
  button.textContent = 'Show onboarding modal';
  button.addEventListener('click', () => showOnboardingModal(select.value));

  wrap.append(select, button);

  return wrap;
}
/* @dev-only:end */

// Configuration
const config = {
  selectors: {
    platformDownloads: '[data-download-card][data-platform]',
    downloadButtons: '[data-download-card][data-platform] [data-download]',
  },
};

// Platform detection → the hero button becomes YOUR download (manus-style):
// label, href, and platform mark come from the detected platform's card. No
// card or no configured URL → the "See every download" fallback stays.
function setupPlatformDetection() {
  const detectedPlatform = omega.utilities.getPlatform();
  console.log('Detected platform:', detectedPlatform);

  const $hero = document.getElementById('download-hero');
  const $fallback = document.getElementById('download-hero-fallback');
  if (!$hero || !$fallback) {
    return;
  }

  // Cards/store rows carry data-download-card — the bare [data-platform]
  // attribute also lives on <html> (detection stamp), forms, and the modal's
  // instruction panes, none of which are download surfaces.
  const $card = document.querySelector(`[data-download-card][data-platform="${detectedPlatform}"]`);
  const $link = $card ? $card.querySelector('a[data-download]') : null;
  if (!$link) {
    return;
  }

  const $chipIcon = $card.querySelector('.omega-dl-card__mark, .omega-icon-chip, .fa');

  $hero.href = $link.getAttribute('href');
  $hero.querySelector('[data-hero-label]').textContent = $link.textContent.trim();
  if ($chipIcon) {
    $hero.querySelector('[data-hero-icon]').innerHTML = $chipIcon.querySelector('svg')?.outerHTML || '';
  }

  // The hero IS a download button: same tracking and onboarding as the cards
  $hero.addEventListener('click', () => {
    trackDownloadClick(detectedPlatform, $link.dataset.downloadName, $hero.href);
    if (!isStoreLink($link)) {
      showOnboardingModal(detectedPlatform);
    }
  });

  $fallback.setAttribute('hidden', '');
  $hero.removeAttribute('hidden');
}

// Setup download button tracking
function setupDownloadTracking() {
  const $downloadButtons = document.querySelectorAll(config.selectors.downloadButtons);

  $downloadButtons.forEach($button => {
    $button.addEventListener('click', function() {
      const $platformPane = this.closest('[data-download-card][data-platform]');
      const platformId = $platformPane ? $platformPane.dataset.platform : 'unknown';
      // The format's own name, never the words: a main half reads
      // "Download for Linux" while it hands over the Debian package.
      const downloadName = this.dataset.downloadName;
      const downloadUrl = this.getAttribute('href');

      trackDownloadClick(platformId, downloadName, downloadUrl);
      if (!isStoreLink(this)) {
        showOnboardingModal(platformId);
      }
    });
  });
}

// A `store` format (the format table's kind, rendered onto the button) is a
// plain link to the store: the store installs it, so there is no walkthrough.
function isStoreLink($link) {
  return $link.dataset.downloadKind === 'store';
}

// Slideshow auto-advance interval (ms)
const SLIDESHOW_INTERVAL = 5000;

// Active slideshow timer
let slideshowTimer = null;

// Show onboarding modal with platform-specific instructions
function showOnboardingModal(platform) {
  const $modal = document.getElementById('onboardingModal');
  if (!$modal) {
    console.error('Onboarding modal not found in DOM');
    return;
  }

  // Store platforms (ios/android) have no install walkthrough — the store
  // handles onboarding; never show an empty modal.
  if (!$modal.querySelector(`.platform-instructions[data-platform="${platform}"]`)) {
    return;
  }

  const $platformInstructions = $modal.querySelectorAll('.platform-instructions');
  $platformInstructions.forEach($el => {
    if ($el.dataset.platform === platform) {
      $el.removeAttribute('hidden');
    } else {
      $el.setAttribute('hidden', '');
    }
  });

  // Initialize slideshow for the active platform
  const $activeInstructions = $modal.querySelector(`.platform-instructions[data-platform="${platform}"]`);
  const $slideshow = $activeInstructions ? $activeInstructions.querySelector('.steps-slideshow') : null;
  if ($slideshow) {
    initSlideshow($slideshow);
  }

  const modal = new bootstrap.Modal($modal);
  modal.show();

  // Stop auto-advance when modal closes
  $modal.addEventListener('hidden.bs.modal', () => {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }, { once: true });
}

// Initialize a slideshow: build dots, show first slide, start auto-advance
function initSlideshow($slideshow) {
  const $slides = $slideshow.querySelectorAll('.step-slide');
  const $dotsContainer = $slideshow.querySelector('.steps-dots');
  const $prevBtn = $slideshow.querySelector('.step-prev');
  const $nextBtn = $slideshow.querySelector('.step-next');
  const totalSteps = $slides.length;

  // Build dots
  $dotsContainer.innerHTML = '';
  for (let i = 0; i < totalSteps; i++) {
    const $dot = document.createElement('button');
    $dot.type = 'button';
    $dot.className = 'step-dot';
    $dot.setAttribute('aria-label', `Step ${i + 1}`);
    $dot.addEventListener('click', () => {
      goToSlide($slideshow, i);
      resetAutoAdvance($slideshow);
    });
    $dotsContainer.appendChild($dot);
  }

  // Show first slide
  goToSlide($slideshow, 0);

  // Nav button handlers
  $prevBtn.addEventListener('click', () => {
    const current = getCurrentSlideIndex($slideshow);
    if (current > 0) {
      goToSlide($slideshow, current - 1);
      resetAutoAdvance($slideshow);
    }
  });

  $nextBtn.addEventListener('click', () => {
    const current = getCurrentSlideIndex($slideshow);
    const $slides = $slideshow.querySelectorAll('.step-slide');
    goToSlide($slideshow, (current + 1) % $slides.length);
    resetAutoAdvance($slideshow);
  });

  // Start auto-advance
  startAutoAdvance($slideshow);
}

// Navigate to a specific slide
function goToSlide($slideshow, index) {
  const $slides = $slideshow.querySelectorAll('.step-slide');
  const $dots = $slideshow.querySelectorAll('.step-dot');
  const $prevBtn = $slideshow.querySelector('.step-prev');

  // Update slides
  $slides.forEach(($slide, i) => {
    $slide.classList.toggle('active', i === index);
  });

  // Update dots
  $dots.forEach(($dot, i) => {
    $dot.classList.toggle('active', i === index);
  });

  // Update nav button states (next always enabled since it loops)
  $prevBtn.disabled = index === 0;

  // Update next button text on last slide
  const $nextBtn = $slideshow.querySelector('.step-next');
  const $nextText = $nextBtn.querySelector('.button-text');
  $nextText.textContent = index === $slides.length - 1 ? 'Restart' : 'Next';
}

// Get current active slide index
function getCurrentSlideIndex($slideshow) {
  const $slides = $slideshow.querySelectorAll('.step-slide');
  for (let i = 0; i < $slides.length; i++) {
    if ($slides[i].classList.contains('active')) {
      return i;
    }
  }
  return 0;
}

// Start auto-advance timer
function startAutoAdvance($slideshow) {
  clearInterval(slideshowTimer);

  slideshowTimer = setInterval(() => {
    const $slides = $slideshow.querySelectorAll('.step-slide');
    const current = getCurrentSlideIndex($slideshow);
    const next = (current + 1) % $slides.length;

    goToSlide($slideshow, next);
  }, SLIDESHOW_INTERVAL);
}

// Reset auto-advance (restart timer after manual interaction)
function resetAutoAdvance($slideshow) {
  startAutoAdvance($slideshow);
}

// Tracking functions
function trackDownloadClick(platform, downloadName, downloadUrl) {
  console.log('Download clicked:', platform, downloadName, downloadUrl);

  // `file_download` is GA4's standard name — the literal `download` this page
  // used to send was a name nothing but us understood (#328 inventory gap 10).
  event('file_download', {
    platform: platform,
    download_name: downloadName,
    download_url: downloadUrl,
  });
}

// Setup copy command buttons
function setupCopyButtons() {
  const $copyButtons = document.querySelectorAll('.copy-command-btn');

  $copyButtons.forEach($button => {
    $button.addEventListener('click', async function() {
      const $input = this.closest('.input-group').querySelector('input');

      if (!$input || !$input.value) {
        return;
      }

      try {
        await omega.utilities.clipboardCopy($input);

        const $text = this.querySelector('.button-text');
        const originalText = $text.textContent;

        $text.textContent = 'Copied!';
        this.classList.remove('btn-outline-adaptive');
        this.classList.add('btn-success');

        setTimeout(() => {
          $text.textContent = originalText;
          this.classList.remove('btn-success');
          this.classList.add('btn-outline-adaptive');
        }, 2000);
      } catch (error) {
        console.error('Failed to copy command:', error);
      }
    });
  });
}

// Setup auto-download when ?auto=true is in the URL
function setupAutoDownload() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('auto') !== 'true') {
    return;
  }

  // Find the first download link in the detected platform's card
  const detectedPlatform = omega.utilities.getPlatform();
  const $pane = document.querySelector(`[data-download-card][data-platform="${detectedPlatform}"]`);

  if (!$pane) {
    return;
  }

  const $downloadLink = $pane.querySelector('a[data-download]');

  if (!$downloadLink) {
    return;
  }

  // Trigger the download and show onboarding modal
  const downloadUrl = $downloadLink.getAttribute('href');
  const downloadName = $downloadLink.dataset.downloadName;

  trackDownloadClick(detectedPlatform, downloadName, downloadUrl);

  // A store has no file to fetch: the visitor goes to the store page
  if (isStoreLink($downloadLink)) {
    window.location.assign(downloadUrl);
    return;
  }

  showOnboardingModal(detectedPlatform);

  // Trigger the actual download via a hidden iframe to avoid navigating away
  const $iframe = document.createElement('iframe');
  $iframe.style.display = 'none';
  $iframe.src = downloadUrl;
  document.body.appendChild($iframe);

  // Clean up URL so refreshing doesn't re-trigger
  const url = new URL(window.location);
  url.searchParams.delete('auto');
  window.history.replaceState({}, '', url);
}

// Setup the mobile notify-me form (ONE form for every unshipped store — the
// address is the same address whichever store lands first)
function setupMobileEmailForms() {
  const $forms = document.querySelectorAll('.mobile-email-form');

  // Warm the backend where the form actually renders: this submit is a POST to
  // `/omega/general/email`, and a visitor looking at the form is one click from
  // it. A page showing no form pings nothing
  // ([#644](https://github.com/Omega-JS-Stack/omega/issues/644)).
  if ($forms.length) {
    omega.request(WAKEUP_ROUTE, { wakeup: true });
  }

  $forms.forEach($form => {
    const formManager = new FormManager(omega, `#${$form.id}`, {
      allowResubmit: false,
      submittingText: 'Sending...',
      submittedText: 'Email Sent!',
    });

    formManager.on('submit', async ({ data }) => {
      console.log('Mobile email form submitted:', { email: data.email });

      // Get API endpoint
      const apiEndpoint = `${omega.getApiUrl()}/omega/general/email`;

      // Send request using wonderful-fetch
      await fetch(apiEndpoint, {
        method: 'POST',
        body: {
          id: 'general:download-app-link',
          email: data.email,
        },
        response: 'json',
        timeout: 30000,
      });

      formManager.showSuccess('Success! Please check your email for the download link.');
    });
  });
}
