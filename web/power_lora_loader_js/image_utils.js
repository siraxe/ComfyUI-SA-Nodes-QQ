/**
 * Image and Video Processing Utilities for WanVideoWrapper QQ
 * Handles image extraction, scaling, and preview generation for LoRA files
 */

import { vidApi } from "./wanvid_api.js";

/**
 * Convert external Civitai image URLs to proxy URLs to avoid CSP violations
 * @param {string} url - Original image URL
 * @returns {string} - Proxied URL if external, original URL if local
 */
export function proxyImageUrl(url) {
    if (!url) return url;

    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Check if this is a Civitai image URL
        if (hostname.includes('civitai.com') || hostname.includes('imagecache.civitai.com') || hostname.includes('image.civitai.com')) {
            // Use the proxy endpoint
            return `/wanvid/api/proxy/image?url=${encodeURIComponent(url)}`;
        }
    } catch (e) {
        // If URL parsing fails, return original
    }

    return url;
}

/**
 * Image Utils class containing all image/video processing functionality
 */
export class ImageUtils {

    /**
     * Extract frame from a video URL
     * First tries to use the video-frame proxy endpoint (backend extraction)
     * Falls back to using an existing video element if provided
     * @param {string} videoUrl - URL of the video
     * @param {number} maxWidth - Maximum width for the extracted frame
     * @param {HTMLVideoElement} videoElement - Optional existing video element to extract frame from
     * @returns {Promise<Blob>} - Blob containing the extracted frame
     */
    static async extractFrameFromVideo(videoUrl, maxWidth = 250, videoElement = null) {
        // If a video element is provided, extract frame from it directly
        if (videoElement && videoElement.readyState >= 2) { // HAVE_CURRENT_DATA
            return this.extractFrameFromVideoElement(videoElement, maxWidth);
        }

        // Use backend proxy to extract frame (server-side)
        const proxiedUrl = proxyImageUrl(videoUrl);
        const frameUrl = `/wanvid/api/proxy/video-frame?url=${encodeURIComponent(videoUrl)}&time=50`;

        try {
            const response = await fetch(frameUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const blob = await response.blob();

            // Scale the extracted frame if needed
            if (maxWidth) {
                return this.scaleImageBlob(blob, maxWidth);
            }
            return blob;

        } catch (error) {
            throw error;
        }
    }

    /**
     * Extract frame from an existing video element using canvas
     * @param {HTMLVideoElement} videoElement - The video element
     * @param {number} maxWidth - Maximum width for the extracted frame
     * @returns {Promise<Blob>} - Extracted frame blob
     */
    static extractFrameFromVideoElement(videoElement, maxWidth = 250) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Calculate dimensions maintaining aspect ratio
                const aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
                const width = Math.min(maxWidth, videoElement.videoWidth);
                const height = width / aspectRatio;

                canvas.width = width;
                canvas.height = height;

                // Draw the current video frame to canvas
                ctx.drawImage(videoElement, 0, 0, width, height);

                // Convert to blob as JPEG
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Failed to convert canvas to blob'));
                    }
                }, 'image/jpeg', 0.9);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Scale an image blob to a maximum width
     * @param {Blob} blob - Image blob
     * @param {number} maxWidth - Maximum width
     * @returns {Promise<Blob>} - Scaled image blob
     */
    static async scaleImageBlob(blob, maxWidth = 250) {
        const bitmap = await createImageBitmap(blob);

        // Calculate dimensions maintaining aspect ratio
        const aspectRatio = bitmap.width / bitmap.height;
        const width = Math.min(maxWidth, bitmap.width);
        const height = width / aspectRatio;

        // Draw to canvas and convert to JPEG blob
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        // Convert to blob as JPEG
        return new Promise((resolve, reject) => {
            canvas.toBlob((result) => {
                if (result) {
                    resolve(result);
                } else {
                    reject(new Error('Failed to convert canvas to blob'));
                }
            }, 'image/jpeg', 0.9);
        });
    }

    /**
     * Scale an image maintaining aspect ratio
     * Uses fetch to bypass CSP restrictions
     * @param {string} imageUrl - URL of the image
     * @param {number} maxHeight - Maximum height for the scaled image
     * @returns {Promise<Blob>} - Blob containing the scaled image
     */
    static async scaleImage(imageUrl, maxHeight = 250) {
        // Use proxy for external Civitai images to avoid CSP violations
        const urlToFetch = proxyImageUrl(imageUrl);

        try {
            // Fetch as blob (bypasses CSP img-src restriction)
            const response = await fetch(urlToFetch);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const blob = await response.blob();

            // Create bitmap from blob to get dimensions
            const bitmap = await createImageBitmap(blob);

            // Calculate dimensions maintaining aspect ratio
            const aspectRatio = bitmap.width / bitmap.height;
            const height = Math.min(maxHeight, bitmap.height);
            const width = height * aspectRatio;

            // Draw to canvas and convert to JPEG blob
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close();

            // Convert to blob as JPEG
            return new Promise((resolve, reject) => {
                canvas.toBlob((result) => {
                    if (result) {
                        resolve(result);
                    } else {
                        reject(new Error('Failed to convert canvas to blob'));
                    }
                }, 'image/jpeg', 0.9);
            });

        } catch (error) {
            throw error;
        }
    }

    /**
     * Process image or video to generate preview
     * @param {Object} mediaInfo - Media object containing url and type
     * @param {number} maxSize - Maximum size (width for video, height for image)
     * @returns {Promise<Blob>} - Processed image blob
     */
    static async processMediaForPreview(mediaInfo, maxSize = 250) {
        if (!mediaInfo || !mediaInfo.url) {
            throw new Error('Invalid media info provided');
        }

        if (mediaInfo.type === 'video') {
            // Extract middle frame from video for better preview representation
            return this.extractFrameFromVideo(mediaInfo.url, maxSize);
        } else {
            return this.scaleImage(mediaInfo.url, maxSize);
        }
    }

    /**
     * Convert blob to data URL for preview/ debugging
     * @param {Blob} blob - Image blob
     * @returns {Promise<string>} - Data URL
     */
    static async blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Save preview image through the backend API
     * @param {string} loraName - Name of the LoRA file (without extension)
     * @param {Blob} imageBlob - Processed image blob
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {string} suffix - Optional suffix for filename (e.g., '_01', '_02')
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Object>} - API response
     */
    static async savePreviewImage(loraName, imageBlob, loraPath = '', suffix = '', type = 'loras') {
        const formData = new FormData();

        // Create a unique filename with optional suffix
        const filename = `${loraName}${suffix}.jpg`;

        formData.append('image', imageBlob, filename);
        if (type === 'checkpoints') {
            formData.append('model_name', loraName);
            formData.append('model_path', loraPath);
            // Also include lora_name for compatibility
            formData.append('lora_name', loraName);
            formData.append('lora_path', loraPath);
        } else {
            formData.append('lora_name', loraName);
            formData.append('lora_path', loraPath);
        }
        formData.append('suffix', suffix);
        formData.append('is_model', type === 'checkpoints' ? 'true' : 'false');

        try {
            const response = await fetch('/wanvid/api/lora/preview-image', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Complete workflow: extract/scale media and save as preview
     * @param {Object} mediaInfo - Media object from dialog info
     * @param {string} loraName - Name of the LoRA
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Object>} - Result of the operation
     */
    static async generateAndSavePreview(mediaInfo, loraName, loraPath = '', type = 'loras') {
        try {
            // Validate inputs
            if (!mediaInfo || !mediaInfo.url) {
                throw new Error('Invalid media info: missing URL');
            }
            if (!loraName || loraName.trim() === '') {
                throw new Error('Invalid LoRA name: empty or undefined');
            }

            // Process the media (extract frame from video or scale image)
            const imageBlob = await this.processMediaForPreview(mediaInfo);

            if (imageBlob.size === 0) {
                throw new Error('Generated image blob is empty');
            }

            // Save through backend API
            const result = await this.savePreviewImage(loraName, imageBlob, loraPath, '', type);

            return result;

        } catch (error) {
            throw error;
        }
    }

    /**
     * Generate and save multiple preview images from available examples
     * @param {Object} info - Dialog info object containing images array
     * @param {string} loraName - Name of the LoRA
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {number} maxImages - Maximum number of preview images to generate
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Array>} - Array of results for each generated preview
     */
    static async generateMultiplePreviews(info, loraName, loraPath = '', maxImages = 3, type = 'loras') {
        try {
            if (!info || !info.images || !info.images.length) {
                throw new Error('No images available in info data');
            }

            const results = [];
            const imagesToProcess = Math.min(maxImages, info.images.length);

            for (let i = 0; i < imagesToProcess; i++) {
                const mediaInfo = info.images[i];
                const suffix = `_${String(i + 1).padStart(2, '0')}`; // _01, _02, _03

                try {
                    // Validate media info
                    if (!mediaInfo || !mediaInfo.url) {
                        continue;
                    }

                    // Process the media
                    const imageBlob = await this.processMediaForPreview(mediaInfo);

                    if (imageBlob.size === 0) {
                        continue;
                    }

                    // Save with suffix
                    const result = await this.savePreviewImage(loraName, imageBlob, loraPath, suffix, type);
                    result.suffix = suffix;
                    results.push(result);

                } catch (error) {
                    // Continue processing other images even if one fails
                }
            }

            if (results.length === 0) {
                throw new Error('Failed to generate any preview images');
            }

            return results;

        } catch (error) {
            throw error;
        }
    }
}

/**
 * Convenience function to generate multiple previews from available media in info
 * @param {Object} info - Dialog info object containing images array
 * @param {string} loraName - Name of the LoRA
 * @param {string} loraPath - Optional relative path within loras directory
 * @param {string} type - Type of item ('loras' or 'checkpoints')
 * @returns {Promise<Object>} - Result of the operation
 */
export async function generatePreviewFromFirstImage(info, loraName, loraPath = '', type = 'loras') {
    if (!info || !info.images || !info.images.length) {
        throw new Error('No images available in info data');
    }

    return ImageUtils.generateMultiplePreviews(info, loraName, loraPath, 3, type);
}

/**
 * Test function to manually trigger preview generation
 * @param {Object} info - Dialog info object containing images array
 * @param {string} loraName - Name of the LoRA
 * @param {string} loraPath - Optional relative path within loras directory
 * @returns {Promise<Object>} - Result of the operation
 */
export async function testPreviewGeneration(info, loraName, loraPath = '') {
    return generatePreviewFromFirstImage(info, loraName, loraPath);
}

/**
 * Debug function to validate image info structure
 * @param {Object} info - Dialog info object
 * @returns {boolean} - True if structure is valid
 */
export function validateImageInfo(info) {
    if (!info) {
        return false;
    }

    if (!info.images || !Array.isArray(info.images)) {
        return false;
    }

    if (info.images.length === 0) {
        return false;
    }

    const firstImage = info.images[0];
    if (!firstImage || !firstImage.url) {
        return false;
    }

    if (!firstImage.type || !['image', 'video'].includes(firstImage.type)) {
        return false;
    }

    return true;
}

export default ImageUtils;