/**
 * Calendar Events (Campaign Editor)
 * Campaign CRUD via FormManager + @omega.js/backend API, modal management,
 * type toggling (email/push), and results viewer.
 */

import { FormManager } from '@omega.js/client/modules/form-manager.js';
import omega from '@omega.js/web/runtime';
import { DISPLAY_TYPES, formatDateUTC, formatTimeUTC, todayUTC } from './calendar-core.js';
import { renderEmailPreview, renderPushPreview } from './campaign-preview.js';

export default class CalendarEvents {
  constructor(core) {
    this.core = core;
    this.editingCampaignId = null;
    this.formManager = null;
    this.$editorModal = null;
    this.$resultsModal = null;

    this._init();
  }

  // ============================================
  // Initialization
  // ============================================
  _init() {
    this._initEditorModal();
    this._initResultsModal();
    this._initForm();
    this._initTypeToggle();
    this._initRecurrenceToggle();
    this._initSendNow();
    this._initCreateButton();
    this._initPreview();
  }

  _initEditorModal() {
    this.$editorModal = document.getElementById('campaign-editor-modal');

    this.$editorModal.addEventListener('hidden.bs.modal', () => {
      this.editingCampaignId = null;
      this.formManager.reset();
      this._toggleDeleteButton(false);
      this._setType('email');
      this._resetRecurrence();
      document.getElementById('campaign-modal-title-text').textContent = 'Create Campaign';
      document.getElementById('campaign-modal-id').classList.add('d-none');
      document.getElementById('campaign-local-time-row').style.display = 'none';
    });

    document.getElementById('campaign-date').addEventListener('input', () => this._updateLocalTimeHint());
    document.getElementById('campaign-time').addEventListener('input', () => this._updateLocalTimeHint());
  }

  _initResultsModal() {
    this.$resultsModal = document.getElementById('campaign-results-modal');

    document.getElementById('btn-retry-campaign').addEventListener('click', () => {
      const campaign = this._retrySource;
      if (!campaign) {
        return;
      }

      this._getResultsModal().hide();

      // Open editor with same settings but no ID (creates new)
      this._populateFormFromCampaign(campaign, false);
      document.getElementById('campaign-modal-title-text').textContent = 'Retry Campaign';
      this._getEditorModal().show();
    });
  }

  _getEditorModal() {
    return bootstrap.Modal.getOrCreateInstance(this.$editorModal);
  }

  _getResultsModal() {
    return bootstrap.Modal.getOrCreateInstance(this.$resultsModal);
  }

  _initForm() {
    this.formManager = new FormManager(omega, '#campaign-editor-form', {
      autoReady: true,
      allowResubmit: true,
    });

    this.formManager.on('validation', ({ $submitButton }) => {
      const action = $submitButton?.value || 'save';
      if (action === 'delete' || action === 'test') {
        this.formManager.clearFieldErrors();
      }
    });

    this.formManager.on('submit', async ({ data, $submitButton }) => {
      const action = $submitButton?.value || 'save';

      if (action === 'delete') {
        if (!this.editingCampaignId) { return; }
        if (!confirm('Delete this campaign? This cannot be undone.')) {
          this.formManager.ready();
          return;
        }
        await this._deleteCampaign(this.editingCampaignId);
        this._getEditorModal().hide();
        return;
      }

      if (action === 'test') {
        const payload = this._buildPayload(data);
        payload.test = true;
        payload.sendAt = 'now';
        delete payload.recurrence;

        if (this.editingCampaignId) {
          payload.recurringId = this.editingCampaignId;
        }

        const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
        await omega.request(url, {
          method: 'POST',
          timeout: 60000,
          tries: 1,
          log: true,
          body: payload,
        });
        this.formManager.showSuccess('Test sent');
        return;
      }

      // Default: save
      const payload = this._buildPayload(data);
      if (this.editingCampaignId) {
        await this._updateCampaign(this.editingCampaignId, payload);
      } else {
        await this._createCampaign(payload);
      }
      this._getEditorModal().hide();
    });
  }

  _initTypeToggle() {
    const $emailFields = document.getElementById('email-fields');
    const $pushFields = document.getElementById('push-fields');
    const $subjectHint = document.getElementById('campaign-subject-hint');

    document.querySelectorAll('input[name="campaign.type"]').forEach(($radio) => {
      $radio.addEventListener('change', () => {
        const isEmail = $radio.value === 'email';
        $emailFields.classList.toggle('d-none', !isEmail);
        $pushFields.classList.toggle('d-none', isEmail);
        $subjectHint.textContent = isEmail ? '(email subject line)' : '(notification body; campaign name is used as title)';
      });
    });
  }

  _initCreateButton() {
    const $btn = document.getElementById('btn-create-campaign');
    if (!$btn) {
      return;
    }
    $btn.addEventListener('click', () => {
      this.openCreateModal(todayUTC(), '09:00');
    });
  }

  _initPreview() {
    const $previewTab = document.getElementById('tab-preview');
    const $previewContainer = document.getElementById('campaign-preview-container');

    // Capture form data BEFORE tab switch (Edit pane still visible), render AFTER
    let pendingData = null;
    $previewTab.addEventListener('show.bs.tab', () => {
      pendingData = this.formManager.getData();
    });
    $previewTab.addEventListener('shown.bs.tab', () => {
      this._renderPreview($previewContainer, pendingData);
      pendingData = null;
    });

    // Handle click-to-test on push notification preview
    $previewContainer.addEventListener('click', (e) => {
      const $notification = e.target.closest('[data-click-action]');
      if (!$notification) {
        return;
      }
      const url = $notification.dataset.clickAction;
      if (url && /^https?:\/\//i.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  }

  async _renderPreview($container, data) {
    data = data || this.formManager.getData();
    const type = (data.campaign && data.campaign.type) || 'email';

    try {
      if (type === 'email') {
        $container.innerHTML = await renderEmailPreview(data);
      } else {
        $container.innerHTML = renderPushPreview(data);
      }
    } catch (error) {
      $container.innerHTML = `<div class="text-danger small">Preview failed: ${omega.utilities.escapeHTML(error.message)}</div>`;
    }
  }

  _initRecurrenceToggle() {
    const $checkbox = document.getElementById('campaign-recurring');
    const $fields = document.getElementById('recurrence-fields');
    const $patternSelect = document.getElementById('campaign-recurrence-pattern');
    const $dayHint = document.getElementById('recurrence-day-hint');
    const $monthRow = document.getElementById('recurrence-month-row');
    const $nthRow = document.getElementById('recurrence-nth-row');
    const $dayInput = document.getElementById('campaign-recurrence-day');

    $checkbox.addEventListener('change', () => {
      $fields.classList.toggle('d-none', !$checkbox.checked);
    });

    $patternSelect.addEventListener('change', () => {
      const pattern = $patternSelect.value;

      const isWeekday = pattern === 'weekly' || pattern === 'monthly-weekday';

      if (isWeekday) {
        $dayHint.textContent = '(of week, 0=Sun)';
        $dayInput.min = 0;
        $dayInput.max = 6;
      } else {
        $dayHint.textContent = '(of month)';
        $dayInput.min = 1;
        $dayInput.max = 31;
      }

      $monthRow.classList.toggle('d-none', pattern !== 'yearly');
      $nthRow.classList.toggle('d-none', pattern !== 'monthly-weekday');
    });
  }

  _initSendNow() {
    document.getElementById('btn-send-now').addEventListener('click', () => {
      const now = new Date();
      document.getElementById('campaign-date').value = formatDateUTC(now);
      document.getElementById('campaign-time').value = formatTimeUTC(now);
      this._updateLocalTimeHint();
    });
  }


  // ============================================
  // Modal Operations
  // ============================================
  openCreateModal(date, time) {
    this.editingCampaignId = null;
    this.formManager.reset();
    this._toggleDeleteButton(false);
    this._showCampaignId(null);
    this._setType('email');
    document.getElementById('campaign-modal-title-text').textContent = 'Create Campaign';

    // Pre-fill date and time
    document.getElementById('campaign-date').value = date || '';
    document.getElementById('campaign-time').value = time || '09:00';
    this._updateLocalTimeHint();

    this._getEditorModal().show();
  }

  openEditModal(campaignId) {
    const campaign = this.core.getCampaign(campaignId);
    if (!campaign) {
      return;
    }

    const displayType = this.core.getCampaignDisplayType(campaign);

    // Virtual recurring occurrences: open the recurring template editor
    if (campaign._virtual) {
      const template = this.core.getCampaign(campaign._recurringSourceId);
      if (!template) {
        return;
      }
      this.editingCampaignId = template.id;
      this._toggleDeleteButton(true);
      this._showCampaignId(template.id);
      document.getElementById('campaign-modal-title-text').textContent = 'Edit Recurring Campaign';
      this._populateFormFromCampaign(template, true);
      this._getEditorModal().show();
      return;
    }

    // History records and sent/failed: read-only results modal
    if (displayType === DISPLAY_TYPES.RECURRING_HISTORY
      || campaign.status === 'sent'
      || campaign.status === 'failed') {
      this._openResultsModal(campaign);
      return;
    }

    // Recurring template: editable only if still pending
    if (displayType === DISPLAY_TYPES.RECURRING_TEMPLATE) {
      if (campaign.status === 'sent' || campaign.status === 'failed') {
        this._openResultsModal(campaign);
        return;
      }
      this.editingCampaignId = campaignId;
      this._toggleDeleteButton(true);
      this._showCampaignId(campaignId);
      document.getElementById('campaign-modal-title-text').textContent = 'Edit Recurring Campaign';
      this._populateFormFromCampaign(campaign, true);
      this._getEditorModal().show();
      return;
    }

    // One-off pending: fully editable
    this.editingCampaignId = campaignId;
    this._toggleDeleteButton(true);
    this._showCampaignId(campaignId);
    document.getElementById('campaign-modal-title-text').textContent = 'Edit Campaign';
    this._populateFormFromCampaign(campaign, true);
    this._getEditorModal().show();
  }

  _openResultsModal(campaign) {
    this._retrySource = campaign;
    const settings = campaign.settings || {};

    document.getElementById('campaign-results-title-text').textContent =
      `${settings.name || 'Campaign'} (${campaign.status === 'sent' ? 'Sent' : 'Failed'})`;

    // Show retry button for failed campaigns
    document.getElementById('btn-retry-campaign').classList.toggle('d-none', campaign.status !== 'failed');

    const $body = document.getElementById('campaign-results-body');
    $body.innerHTML = this._renderResultsBody(campaign);

    this._getResultsModal().show();
  }

  // ============================================
  // Form Population
  // ============================================
  _populateFormFromCampaign(campaign, isEditing) {
    const settings = campaign.settings || {};
    const d = new Date(campaign.sendAt * 1000);

    // Type
    this._setType(campaign.type || 'email');

    // Shared fields
    document.getElementById('campaign-name').value = settings.name || '';
    document.getElementById('campaign-subject').value = settings.subject || '';
    document.getElementById('campaign-date').value = formatDateUTC(d);
    document.getElementById('campaign-time').value = formatTimeUTC(d);
    const contentData = settings.data?.content || {};
    document.getElementById('campaign-discount-code').value = contentData.discountCode || '';
    document.getElementById('campaign-test').checked = !!settings.test;

    // Targeting
    document.getElementById('campaign-all').checked = !!settings.all;
    document.getElementById('campaign-segments').value = (settings.segments || []).join(', ');
    document.getElementById('campaign-exclude-segments').value = (settings.excludeSegments || []).join(', ');

    // Email fields
    document.getElementById('campaign-preheader').value = settings.preheader || '';
    document.getElementById('campaign-content').value = contentData.message || '';
    document.getElementById('campaign-template').value = settings.template || 'card';
    document.getElementById('campaign-sender').value = settings.sender || 'marketing';

    // Push fields
    document.getElementById('campaign-icon').value = settings.icon || '';
    document.getElementById('campaign-click-action').value = settings.clickAction || '';
    document.getElementById('campaign-push-tags').value =
      (settings.filters && settings.filters.tags) ? settings.filters.tags.join(', ') : '';
    document.getElementById('campaign-push-owner').value =
      (settings.filters && settings.filters.owner) || '';

    // Lists
    document.getElementById('campaign-lists').value = (settings.lists || []).join(', ');

    // Providers (checkboxes, one per role word the send code matches)
    const providers = settings.providers || [];
    document.getElementById('campaign-provider-campaigns').checked = providers.includes('campaigns');
    document.getElementById('campaign-provider-newsletter').checked = providers.includes('newsletter');

    // Advanced
    document.getElementById('campaign-group').value = settings.group || '';
    document.getElementById('campaign-categories').value = (settings.categories || []).join(', ');

    // UTM
    const utm = settings.utm || {};
    const utmFields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    utmFields.forEach((key) => {
      const $input = document.querySelector(`input[name="campaign.utm.${key}"]`);
      if ($input) {
        $input.value = utm[key] || '';
      }
    });

    // Recurrence
    const recurrence = campaign.recurrence;
    const $recurringCheckbox = document.getElementById('campaign-recurring');
    const $recurrenceFields = document.getElementById('recurrence-fields');

    if (recurrence) {
      const pattern = recurrence.pattern || 'monthly';
      const isWeekday = pattern === 'weekly' || pattern === 'monthly-weekday';

      $recurringCheckbox.checked = true;
      $recurrenceFields.classList.remove('d-none');
      document.getElementById('campaign-recurrence-pattern').value = pattern;
      document.getElementById('campaign-recurrence-hour').value = recurrence.hour || 0;
      document.getElementById('campaign-recurrence-minute').value = recurrence.minute || 0;
      document.getElementById('campaign-recurrence-day').value = recurrence.day || 1;
      document.getElementById('campaign-recurrence-nth').value = recurrence.nth || 2;
      document.getElementById('campaign-recurrence-month').value = recurrence.month || 1;

      document.getElementById('recurrence-month-row').classList.toggle('d-none', pattern !== 'yearly');
      document.getElementById('recurrence-nth-row').classList.toggle('d-none', pattern !== 'monthly-weekday');

      const $dayHint = document.getElementById('recurrence-day-hint');
      const $dayInput = document.getElementById('campaign-recurrence-day');
      $dayHint.textContent = isWeekday ? '(of week, 0=Sun)' : '(of month)';
      $dayInput.min = isWeekday ? 0 : 1;
      $dayInput.max = isWeekday ? 6 : 31;
    } else {
      $recurringCheckbox.checked = false;
      $recurrenceFields.classList.add('d-none');
    }

    this._updateLocalTimeHint();
  }

  _setType(type) {
    const $radio = document.getElementById(`campaign-type-${type}`);
    if ($radio) {
      $radio.checked = true;
      $radio.dispatchEvent(new Event('change'));
    }
  }

  _showCampaignId(id) {
    const $el = document.getElementById('campaign-modal-id');
    if (id) {
      $el.textContent = id;
      $el.classList.remove('d-none');
    } else {
      $el.classList.add('d-none');
    }
  }

  _updateLocalTimeHint() {
    const $row = document.getElementById('campaign-local-time-row');
    const $hint = document.getElementById('campaign-time-local');
    const date = document.getElementById('campaign-date').value;
    const time = document.getElementById('campaign-time').value;

    if (!date || !time) {
      $row.style.display = 'none';
      return;
    }

    const [y, mo, d] = date.split('-').map(Number);
    const [h, m] = time.split(':').map(Number);
    const utc = new Date(Date.UTC(y, mo - 1, d, h, m));

    const localStr = utc.toLocaleString('en', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    $hint.textContent = `Local: ${localStr}`;
    $row.style.display = '';
  }

  // ============================================
  // Payload Building
  // ============================================
  _buildPayload(formData) {
    const c = formData.campaign || {};
    const type = c.type || 'email';

    // Convert date + time to sendAt
    const sendAt = this._dateTimeToISO(c.date, c.time);

    const payload = {
      type,
      name: (c.name || '').trim(),
      subject: (c.subject || '').trim(),
      sendAt,
    };

    // Config
    if (c.test) {
      payload.test = true;
    }

    // Providers (checkboxes → array)
    const providersCb = c.providers || {};
    const providers = Object.keys(providersCb).filter((p) => providersCb[p]);
    if (providers.length) {
      payload.providers = providers;
    }

    // Targeting
    if (c.all) {
      payload.all = true;
    }
    const lists = this._csvToArray(c.lists);
    if (lists.length) {
      payload.lists = lists;
    }
    const segments = this._csvToArray(c.segments);
    if (segments.length) {
      payload.segments = segments;
    }
    const excludeSegments = this._csvToArray(c.excludeSegments);
    if (excludeSegments.length) {
      payload.excludeSegments = excludeSegments;
    }

    // Email-specific
    if (type === 'email') {
      if (c.preheader) {
        payload.preheader = c.preheader.trim();
      }
      if (c.template && c.template !== 'card') {
        payload.template = c.template;
      }
      if (c.sender) {
        payload.sender = c.sender;
      }

      const content = {};
      if (c.content) {
        content.message = c.content;
      }
      if (c.discountCode) {
        content.discountCode = c.discountCode.trim();
      }
      if (Object.keys(content).length) {
        payload.data = { ...payload.data, content };
      }
    }

    // Push-specific
    if (type === 'push') {
      if (c.icon) {
        payload.icon = c.icon.trim();
      }
      if (c.clickAction) {
        payload.clickAction = c.clickAction.trim();
      }
      const filters = c.filters || {};
      const tags = this._csvToArray(filters.tags);
      if (tags.length || filters.owner) {
        payload.filters = {};
        if (tags.length) {
          payload.filters.tags = tags;
        }
        if (filters.owner) {
          payload.filters.owner = filters.owner.trim();
        }
      }
    }

    // Advanced
    if (c.group) {
      payload.group = c.group.trim();
    }
    const categories = this._csvToArray(c.categories);
    if (categories.length) {
      payload.categories = categories;
    }

    // UTM
    const utm = c.utm || {};
    const utmClean = {};
    let hasUtm = false;
    Object.entries(utm).forEach(([key, val]) => {
      if (val && val.trim()) {
        utmClean[key] = val.trim();
        hasUtm = true;
      }
    });
    if (hasUtm) {
      payload.utm = utmClean;
    }

    // Recurrence
    if (c.recurring) {
      const rec = c.recurrence || {};
      const pattern = rec.pattern || 'monthly';
      payload.recurrence = {
        pattern,
        hour: parseInt(rec.hour, 10) || 0,
        minute: parseInt(rec.minute, 10) || 0,
        day: parseInt(rec.day, 10) || 1,
      };
      if (pattern === 'monthly-weekday') {
        payload.recurrence.nth = parseInt(rec.nth, 10) || 1;
      }
      if (pattern === 'yearly') {
        payload.recurrence.month = parseInt(rec.month, 10) || 1;
      }
    }

    return payload;
  }

  _dateTimeToISO(date, time) {
    if (!date || !time) {
      return 'now';
    }
    return `${date}T${time}:00Z`;
  }

  _csvToArray(str) {
    if (!str) {
      return [];
    }
    // Handle both string and array inputs
    if (Array.isArray(str)) {
      return str;
    }
    return str.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // ============================================
  // @omega.js/backend API Calls
  // ============================================
  async _createCampaign(payload) {
    const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
    const response = await omega.request(url, {
      method: 'POST',
      timeout: 60000,
      tries: 1,
      log: true,
      body: payload,
    });

    this.formManager.showSuccess('Campaign created');


    return response;
  }

  async _updateCampaign(id, payload) {
    payload.id = id;
    const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
    const response = await omega.request(url, {
      method: 'PUT',
      timeout: 60000,
      tries: 1,
      log: true,
      body: payload,
    });

    this.formManager.showSuccess('Campaign updated');


    return response;
  }

  async _deleteCampaign(id) {
    const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
    const response = await omega.request(url, {
      method: 'DELETE',
      timeout: 60000,
      tries: 1,
      log: true,
      body: { id },
    });


    return response;
  }

  /**
   * Reschedule a one-off campaign (drag-and-drop)
   */
  async rescheduleCampaign(id, newSendAt) {
    const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
    return omega.request(url, {
      method: 'PUT',
      timeout: 60000,
      tries: 1,
      log: true,
      body: { id, sendAt: newSendAt },
    });
  }

  /**
   * Reschedule a recurring campaign by updating its sendAt (seed time).
   * All virtual occurrences recalculate from the new seed.
   * Also updates recurrence metadata (day/hour) for the backend cron.
   * @param {string} templateId - The recurring template doc ID
   * @param {object} virtualEvent - The virtual event that was dragged
   * @param {number} newSendAtUNIX - New sendAt as unix timestamp
   */
  async rescheduleRecurring(templateId, virtualEvent, newSendAtUNIX) {
    const template = this.core.getCampaign(templateId);
    if (!template || !template.recurrence) {
      return;
    }

    const recurrence = { ...template.recurrence };
    const d = new Date(newSendAtUNIX * 1000);

    // Update recurrence metadata for the backend cron
    recurrence.hour = d.getUTCHours();
    recurrence.minute = d.getUTCMinutes();
    if (recurrence.pattern === 'weekly') {
      recurrence.day = d.getUTCDay();
    } else if (recurrence.pattern === 'monthly-weekday') {
      recurrence.day = d.getUTCDay();
      // Calculate which occurrence of this weekday falls on this date (1st, 2nd, 3rd, 4th)
      recurrence.nth = Math.ceil(d.getUTCDate() / 7);
    } else if (recurrence.pattern === 'monthly' || recurrence.pattern === 'quarterly') {
      recurrence.day = d.getUTCDate();
    } else if (recurrence.pattern === 'yearly') {
      recurrence.month = d.getUTCMonth() + 1;
      recurrence.day = d.getUTCDate();
    }

    // Optimistic update: move the seed sendAt, re-render immediately
    const rollback = this.core.optimisticUpdateSendAt(templateId, newSendAtUNIX);

    const url = `${omega.getApiUrl()}/omega/marketing/campaign`;
    return omega.request(url, {
      method: 'PUT',
      timeout: 60000,
      tries: 1,
      log: true,
      body: {
        id: templateId,
        sendAt: d.toISOString(),
        recurrence,
      },
    }).catch((err) => {
      console.error('Failed to reschedule recurring campaign:', err);
      if (rollback) {
        rollback();
      }
    });
  }

  // ============================================
  // Results Rendering
  // ============================================
  _renderResultsBody(campaign) {
    const settings = campaign.settings || {};
    const results = campaign.results || {};
    const d = new Date(campaign.sendAt * 1000);

    let html = '';

    // Status badge
    const statusBadge = campaign.status === 'sent'
      ? `<span class="badge bg-success"><i class="fa-solid fa-circle-check fa-xs me-1"></i> Sent</span>`
      : `<span class="badge bg-danger"><i class="fa-solid fa-triangle-exclamation fa-xs me-1"></i> Failed</span>`;

    // Overview
    html += '<div class="mb-4">';
    html += `<div class="d-flex align-items-center gap-2 mb-2">`;
    html += statusBadge;
    html += `<span class="badge bg-${campaign.type === 'email' ? 'primary' : 'success'}">${campaign.type === 'email' ? 'Email' : 'Push'}</span>`;
    html += `</div>`;
    html += `<table class="table table-sm table-borderless mb-0">`;
    html += `<tr><td class="text-muted" style="width:120px">ID</td><td><code>${omega.utilities.escapeHTML(campaign.id)}</code></td></tr>`;
    html += `<tr><td class="text-muted">Name</td><td>${omega.utilities.escapeHTML(settings.name || '')}</td></tr>`;
    html += `<tr><td class="text-muted">Subject</td><td>${omega.utilities.escapeHTML(settings.subject || '')}</td></tr>`;
    html += `<tr><td class="text-muted">Test</td><td>${settings.test ? '<span class="badge bg-warning">Yes</span>' : 'No'}</td></tr>`;
    const localStr = d.toLocaleString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    html += `<tr><td class="text-muted">Sent At</td><td>${formatDateUTC(d)} ${formatTimeUTC(d)} UTC <span class="text-muted">(${localStr})</span></td></tr>`;

    if (campaign.type === 'email') {
      if (settings.preheader) {
        html += `<tr><td class="text-muted">Preheader</td><td>${omega.utilities.escapeHTML(settings.preheader)}</td></tr>`;
      }
      if (settings.sender) {
        html += `<tr><td class="text-muted">Sender</td><td>${omega.utilities.escapeHTML(settings.sender)}</td></tr>`;
      }
      if (settings.template) {
        html += `<tr><td class="text-muted">Template</td><td>${omega.utilities.escapeHTML(settings.template)}</td></tr>`;
      }
    }

    if (campaign.type === 'push') {
      if (settings.icon) {
        const iconUrl = /^https?:\/\//i.test(settings.icon) ? omega.utilities.escapeHTML(settings.icon) : '#';
        html += `<tr><td class="text-muted">Icon</td><td><a href="${iconUrl}" target="_blank" rel="noopener">${omega.utilities.escapeHTML(settings.icon)}</a></td></tr>`;
      }
      if (settings.clickAction) {
        const clickUrl = /^https?:\/\//i.test(settings.clickAction) ? omega.utilities.escapeHTML(settings.clickAction) : '#';
        html += `<tr><td class="text-muted">Click URL</td><td><a href="${clickUrl}" target="_blank" rel="noopener">${omega.utilities.escapeHTML(settings.clickAction)}</a></td></tr>`;
      }
    }

    if (campaign.recurringId) {
      html += `<tr><td class="text-muted">Recurring</td><td>${omega.utilities.escapeHTML(campaign.recurringId)}</td></tr>`;
    }

    html += `</table>`;
    html += '</div>';

    // Content (email only)
    const resultContent = settings.data?.content?.message;
    if (campaign.type === 'email' && resultContent) {
      html += '<div class="mb-4">';
      html += '<h6>Content</h6>';
      html += `<pre class="bg-body-tertiary p-3 rounded small" style="white-space:pre-wrap;max-height:200px;overflow-y:auto">${omega.utilities.escapeHTML(resultContent)}</pre>`;
      html += '</div>';
    }

    // Results
    if (Object.keys(results).length > 0) {
      html += '<div class="mb-3">';
      html += '<h6>Results</h6>';
      html += `<pre class="bg-body-tertiary p-3 rounded small" style="white-space:pre-wrap;max-height:300px;overflow-y:auto">${omega.utilities.escapeHTML(JSON.stringify(results, null, 2))}</pre>`;
      html += '</div>';
    }

    return html;
  }

  // ============================================
  // UI Helpers
  // ============================================
  _toggleDeleteButton(show) {
    document.getElementById('btn-delete-campaign').classList.toggle('d-none', !show);
  }

  _resetRecurrence() {
    document.getElementById('campaign-recurring').checked = false;
    document.getElementById('recurrence-fields').classList.add('d-none');
    document.getElementById('campaign-recurrence-pattern').value = 'monthly';
    document.getElementById('campaign-recurrence-hour').value = '14';
    document.getElementById('campaign-recurrence-minute').value = '0';
    document.getElementById('campaign-recurrence-day').value = '1';
    document.getElementById('campaign-recurrence-nth').value = '2';
    document.getElementById('campaign-recurrence-month').value = '1';
    document.getElementById('recurrence-month-row').classList.add('d-none');
    document.getElementById('recurrence-nth-row').classList.add('d-none');
  }

}
