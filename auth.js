/* ===================== Waypoint — auth.js =====================
 * Gates the app behind Supabase email+password auth.
 * On successful session, dispatches window "waypoint:authed" with
 * { detail: { userId } } — app.js/sync.js wait for this before touching
 * IndexedDB/remote data. On sign-out, dispatches "waypoint:signedout".
 * ================================================================= */

const supabaseClient = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);
window.supabaseClient = supabaseClient; // used by sync.js

(function () {
  let mode = 'signin'; // 'signin' | 'signup'

  const els = {
    overlay: document.getElementById('overlayAuth'),
    title: document.getElementById('authTitle'),
    hint: document.getElementById('authHint'),
    email: document.getElementById('authEmail'),
    passwordField: document.getElementById('authPasswordField'),
    password: document.getElementById('authPassword'),
    error: document.getElementById('authError'),
    notice: document.getElementById('authNotice'),
    submit: document.getElementById('authSubmit'),
    toggleMode: document.getElementById('authToggleMode'),
    forgot: document.getElementById('authForgotPassword'),
  };

  function showError(msg) {
    els.error.textContent = msg;
    els.error.style.display = 'block';
    els.notice.style.display = 'none';
  }
  function showNotice(msg) {
    els.notice.textContent = msg;
    els.notice.style.display = 'block';
    els.error.style.display = 'none';
  }
  function clearMessages() {
    els.error.style.display = 'none';
    els.notice.style.display = 'none';
  }

  function setMode(next) {
    mode = next;
    clearMessages();
    if (mode === 'signin') {
      els.title.textContent = 'Sign in to Waypoint';
      els.hint.textContent = 'Your waypoints sync to your account and stay private to you.';
      els.submit.textContent = 'Sign in';
      els.toggleMode.textContent = 'Create an account';
      els.passwordField.style.display = 'block';
    } else {
      els.title.textContent = 'Create your account';
      els.hint.textContent = 'We\'ll email you a verification link before you can sign in.';
      els.submit.textContent = 'Sign up';
      els.toggleMode.textContent = 'Already have an account? Sign in';
      els.passwordField.style.display = 'block';
    }
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  async function handleSubmit() {
    clearMessages();
    const email = els.email.value.trim();
    const password = els.password.value;

    if (!isValidEmail(email)) { showError('Enter a valid email address.'); return; }
    if (password.length < 8) { showError('Password must be at least 8 characters.'); return; }

    els.submit.disabled = true;
    const prevLabel = els.submit.textContent;
    els.submit.textContent = mode === 'signin' ? 'Signing in…' : 'Signing up…';

    try {
      if (mode === 'signin') {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (!data.session) throw new Error('No session returned.');
        // handled by onAuthStateChange below
      } else {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) throw error;
        if (data.user && !data.session) {
          showNotice('Check your email to verify your account, then sign in.');
          setMode('signin');
        }
      }
    } catch (err) {
      // Supabase's own messages are already user-safe (no stack traces, no internals).
      showError(err.message || 'Something went wrong. Try again.');
    } finally {
      els.submit.disabled = false;
      els.submit.textContent = prevLabel;
    }
  }

  async function handleForgotPassword() {
    clearMessages();
    const email = els.email.value.trim();
    if (!isValidEmail(email)) { showError('Enter your email above first, then tap "Forgot password?".'); return; }
    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) throw error;
      showNotice('Password reset email sent — check your inbox.');
    } catch (err) {
      showError(err.message || 'Could not send reset email.');
    }
  }

  els.submit.addEventListener('click', handleSubmit);
  els.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
  els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
  els.toggleMode.addEventListener('click', (e) => { e.preventDefault(); setMode(mode === 'signin' ? 'signup' : 'signin'); });
  els.forgot.addEventListener('click', (e) => { e.preventDefault(); handleForgotPassword(); });

  // Handle the "password recovery" link the user clicks from their email:
  // Supabase signs them in with a temporary recovery session and fires this event.
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      const newPassword = prompt('Enter a new password (min 8 characters):');
      if (newPassword && newPassword.length >= 8) {
        supabaseClient.auth.updateUser({ password: newPassword }).then(({ error }) => {
          if (error) alert('Could not update password: ' + error.message);
          else alert('Password updated. You are now signed in.');
        });
      }
      return;
    }

    if (session && session.user) {
      els.overlay.classList.remove('show');
      window.dispatchEvent(new CustomEvent('waypoint:authed', { detail: { userId: session.user.id } }));
    } else {
      els.overlay.classList.add('show');
      window.dispatchEvent(new Event('waypoint:signedout'));
    }
  });

  // Initial check on load (onAuthStateChange also fires once at startup, but
  // this makes intent explicit and avoids a flash of the unauthenticated UI).
  supabaseClient.auth.getSession().then(({ data }) => {
    if (!data.session) els.overlay.classList.add('show');
  });

  setMode('signin');

  // Exposed for a future "Sign out" button in settings.
  window.WaypointAuth = {
    signOut: () => supabaseClient.auth.signOut(),
  };
})();
