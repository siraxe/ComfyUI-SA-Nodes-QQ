export const qq = {
    showMessage: function(options) {
        if (typeof options === 'string') {
            // If it's just a string, convert to options object
            options = { message: options };
        }

        const message = options.message || options.body || 'Unknown message';
        const timeout = options.timeout || 3000;
        const type = options.type || 'info';

        // Create nice toast message
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${type === 'error' ? '#d32f2f' : type === 'success' ? '#388e3c' : '#333'};
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: Arial, sans-serif;
            font-size: 12px;
            max-width: 300px;
            word-wrap: break-word;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Auto-remove after timeout
        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, timeout);
    },

    isDevMode: function() {
        // Check if we're in development mode
        return window.location.hostname === '127.0.0.1' ||
               window.location.hostname === 'localhost' ||
               window.location.port === '8188';
    }
};