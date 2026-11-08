// Import necessary modules
import { generatePreviewFromFirstImage } from "./image_utils.js";
import { vidApi } from "./wanvid_api.js";

/**
 * Batch Fetch Service - Handles bulk LoRA info fetching and preview generation
 * Extracted from lora_picker_dialog.js to keep code organized and reusable
 */
export class BatchFetchService {
    constructor() {
        this.cancelFlag = false;
        this.abortController = null;
    }

    // =============================================================================
    // BATCH FETCHING CONFIGURATION PARAMETERS
    // =============================================================================
    // Tweak these values to optimize performance and API rate limit handling
    static BATCH_CONFIG = {
        // Processing parameters
        BATCH_SIZE: 5,                    // Number of LoRAs to process in each batch
        MAX_CONCURRENT_REQUESTS: 3,       // Max parallel API calls (for rate limiting)
        ADAPTIVE_DELAY_BASE: 200,         // Base delay between API calls (adaptive)
        INTER_BATCH_DELAY: 500,           // Reduced delay between batches (ms)

        // Rate limiting and retry parameters
        MAX_RETRIES: 2,                   // Maximum retry attempts for failed API calls
        RETRY_DELAY: 2000,               // Delay between retry attempts (ms)

        // Progress and UI parameters
        PROGRESS_UPDATE_INTERVAL: 100,    // How often to update progress UI (ms)

        // API timeout parameters
        API_TIMEOUT: 30000,               // Timeout for individual API calls (ms)
        CIVITAI_TIMEOUT: 45000,           // Timeout for Civitai API calls (longer for large files)
        PREVIEW_GENERATION_TIMEOUT: 60000, // Timeout for preview generation (can be slow for videos)

        // Retry parameters
        MAX_RETRIES: 2,                   // Maximum retry attempts for failed API calls
        RETRY_DELAY: 2000,               // Delay between retry attempts (ms)
        RETRY_BACKOFF_MULTIPLIER: 1.5,    // Backoff multiplier for consecutive retries

        // Performance tuning
        CONCURRENT_REQUESTS: 3,           // Max concurrent API requests (reduces from BATCH_SIZE if needed)
        ADAPTIVE_DELAY_ENABLED: true,     // Enable adaptive delay based on response times
        BASE_DELAY_MULTIPLIER: 1.0,       // Multiplier for all delays (increase if hitting rate limits)

        // Video processing settings
        SKIP_VIDEO_PREVIEWS: true,        // Skip video preview generation to prevent timeouts
        VIDEO_FRAME_TIMEOUT: 10000,       // Timeout for video frame extraction (ms)

        // Cancellation and cleanup
        CANCELLATION_CHECK_INTERVAL: 100, // How often to check for cancellation (ms)
        CLEANUP_ON_CANCEL: true,          // Whether to clean up partial progress on cancel
    };

    /**
     * Create a delay that can be cancelled
     * @param {number} ms - Delay in milliseconds
     * @param {Function} checkCancelled - Function to check if operation was cancelled
     * @returns {Promise} Promise that resolves after delay or rejects on cancellation
     */
    async createCancellableDelay(ms, checkCancelled) {
        const startTime = Date.now();
        const checkInterval = 25; // Check every 25ms for even better responsiveness

        return new Promise((resolve, reject) => {
            const checkCancel = () => {
                if (this.cancelFlag || checkCancelled()) {
                    reject(new Error('Operation cancelled'));
                    return;
                }

                const elapsed = Date.now() - startTime;
                if (elapsed >= ms) {
                    resolve();
                } else {
                    setTimeout(checkCancel, Math.min(checkInterval, ms - elapsed));
                }
            };

            checkCancel();
        });
    }

    /**
     * Create a promise with timeout that can be cancelled
     * @param {Promise} promise - The promise to wrap with timeout
     * @param {number} timeoutMs - Timeout in milliseconds
     * @param {Function} checkCancelled - Function to check if operation was cancelled
     * @returns {Promise} Promise that resolves or rejects based on timeout/cancellation
     */
    async createCancellablePromise(promise, timeoutMs, checkCancelled) {
        const startTime = Date.now();

        return new Promise(async (resolve, reject) => {
            let isResolved = false;
            let isRejected = false;

            // Cancellation/timeout checker
            const checkInterval = setInterval(() => {
                if (this.cancelFlag || checkCancelled()) {
                    if (!isResolved && !isRejected) {
                        isRejected = true;
                        clearInterval(checkInterval);
                        reject(new Error('Operation cancelled'));
                    }
                }

                const elapsed = Date.now() - startTime;
                if (elapsed >= timeoutMs) {
                    if (!isResolved && !isRejected) {
                        isRejected = true;
                        clearInterval(checkInterval);
                        reject(new Error('Operation timeout'));
                    }
                }
            }, 25); // Check every 25ms

            try {
                const result = await promise;
                if (!isRejected) {
                    isResolved = true;
                    clearInterval(checkInterval);
                    resolve(result);
                }
            } catch (error) {
                if (!isRejected) {
                    isRejected = true;
                    clearInterval(checkInterval);
                    reject(error);
                }
            }
        });
    }

    /**
     * Check if images contain videos and optionally filter them out
     * @param {Object} loraInfo - LoRA info object containing images
     * @returns {Object} Filtered result with video status
     */
    filterVideoImages(loraInfo) {
        if (!loraInfo || !loraInfo.images || loraInfo.images.length === 0) {
            return { hasImages: false, hasVideos: false, filteredImages: [] };
        }

        const filteredImages = [];
        let hasVideos = false;
        let videoCount = 0;

        for (const image of loraInfo.images) {
            const isVideo = image.url && (
                image.url.includes('.mp4') ||
                image.url.includes('.mov') ||
                image.url.includes('.avi') ||
                image.url.includes('.webm') ||
                image.type === 'video'
            );

            if (isVideo) {
                hasVideos = true;
                videoCount++;

                // Only skip if SKIP_VIDEO_PREVIEWS is enabled
                if (!BatchFetchService.BATCH_CONFIG.SKIP_VIDEO_PREVIEWS) {
                    filteredImages.push(image);
                }
            } else {
                filteredImages.push(image);
            }
        }

        if (hasVideos) {
        }

        return {
            hasImages: filteredImages.length > 0,
            hasVideos: hasVideos,
            videoCount: videoCount,
            filteredImages: filteredImages,
            originalCount: loraInfo.images.length
        };
    }

    /**
     * Check if a LoRA has a placeholder preview image
     * @param {string} loraName - Name of the LoRA
     * @returns {Promise<boolean>} True if placeholder preview exists
     */
    async hasPlaceholderPreview(loraName) {
        try {
            // Check for placeholder preview using the same API that serves preview images
            const cleanLoraName = loraName.replace(/\.[^/.]+$/, ""); // Remove extension
            const response = await fetch(`/wanvid/api/loras/preview?file=${encodeURIComponent(cleanLoraName + '_01.jpg')}`);

            return response.ok;
        } catch (error) {
            return false;
        }
    }

    /**
     * Copy the no_preview.jpg placeholder as a preview for LoRAs with no images
     * @param {string} loraName - Name of the LoRA
     * @returns {Promise<void>}
     */
    async createPlaceholderPreview(loraName) {
        try {
            const cleanLoraName = loraName.replace(/\.[^/.]+$/, ""); // Remove extension

            // Fetch the no_preview.jpg placeholder
            const placeholderResponse = await fetch('/wanvid/api/loras/preview?file=no_preview.jpg');
            if (!placeholderResponse.ok) {
                throw new Error('Failed to fetch no_preview.jpg placeholder');
            }

            const placeholderBlob = await placeholderResponse.blob();

            // Create form data to save as preview with _01 suffix
            const formData = new FormData();
            formData.append('lora_name', cleanLoraName);
            formData.append('suffix', '_01'); // Use _01 suffix
            formData.append('image', placeholderBlob, `${cleanLoraName}_01.jpg`);

            const saveResponse = await fetch('/wanvid/api/lora/preview-image', {
                method: 'POST',
                body: formData
            });

            if (!saveResponse.ok) {
                const errorData = await saveResponse.json();
                throw new Error(errorData.error || `HTTP ${saveResponse.status}`);
            }

            const result = await saveResponse.json();

        } catch (error) {
            console.error(`Failed to create placeholder preview for ${loraName}:`, error);
            throw error;
        }
    }

    /**
     * Process a single LoRA with parallel execution support
     * @param {string} loraName - LoRA name to process
     * @param {number} index - Index in overall processing
     * @param {number} total - Total number of LoRAs
     * @param {Function} checkCancelled - Cancellation check function
     * @param {Function} updateProgress - Progress update function
     * @param {Function} updateText - Text update function
     * @returns {Promise<Object>} Processing result
     */
    async processSingleLora(loraName, index, total, checkCancelled, updateProgress, updateText) {
        try {
            // Update progress for this LoRA
            const overallProgress = (index / total) * 100;
            updateProgress(overallProgress);
            updateText(`Processing ${loraName} (${index + 1}/${total})`);


            // Stage 1: Fetch LoRA info with retry logic
            const loraInfo = await this.fetchLoraInfoWithRetry(loraName, checkCancelled);

            // Check for cancellation after info fetching
            if (this.cancelFlag || checkCancelled()) {
                throw new Error('Operation cancelled');
            }

            // Stage 2: Generate preview images if we have image data
            let previewResult = null;
            if (loraInfo && loraInfo.images && loraInfo.images.length > 0) {
                // Filter out video previews to prevent timeouts
                const imageFilter = this.filterVideoImages(loraInfo);

                if (!imageFilter.hasImages) {
                    return {
                        success: true,
                        loraName,
                        loraInfo,
                        previewResult: null,
                        hasPreview: false,
                        index,
                        skippedVideos: imageFilter.videoCount,
                        needsPlaceholderPreview: true  // Mark that this LoRA needs a placeholder preview
                    };
                }

                // Create a copy of loraInfo with filtered images
                const filteredLoraInfo = {
                    ...loraInfo,
                    images: imageFilter.filteredImages
                };

                updateText(`Generating preview for ${loraName} (${index + 1}/${total})`);

                previewResult = await this.generatePreviewsWithRetry(filteredLoraInfo, checkCancelled);

                // Check for cancellation after preview generation
                if (this.cancelFlag || checkCancelled()) {
                    throw new Error('Operation cancelled');
                }
            } else {
            }

            return {
                success: true,
                loraName,
                loraInfo,
                previewResult,
                hasPreview: !!(previewResult && previewResult.success),
                index,
                skippedVideos: 0,
                needsPlaceholderPreview: !loraInfo || !loraInfo.images || loraInfo.images.length === 0
            };

        } catch (error) {
            if (error.message === 'Operation cancelled') {
                throw error;
            }

            console.error(`✗ Failed to process ${loraName}:`, error);
            // Categorize the error type for better reporting
            let errorType = 'unknown';
            if (error.message.includes('timeout') || error.message.includes('Timeout')) {
                errorType = 'timeout';
            } else if (error.message.includes('network') || error.message.includes('fetch')) {
                errorType = 'network';
            } else if (error.message.includes('API') || error.message.includes('404') || error.message.includes('500')) {
                errorType = 'api_error';
            } else if (error.message.includes('preview') || error.message.includes('image')) {
                errorType = 'preview_generation';
            }

            return {
                success: false,
                loraName,
                error: error.message,
                errorType: errorType,
                hasPreview: false,
                index
            };
        }
    }

    /**
     * Process multiple LoRAs in parallel with concurrency limiting
     * @param {Array} loraBatch - Array of LoRA names to process
     * @param {number} startIndex - Starting index for progress tracking
     * @param {number} total - Total number of LoRAs
     * @param {Function} checkCancelled - Cancellation check function
     * @param {Function} updateProgress - Progress update function
     * @param {Function} updateText - Text update function
     * @returns {Promise<Array>} Array of processing results
     */
    async processBatchParallel(loraBatch, startIndex, total, checkCancelled, updateProgress, updateText) {
        const maxConcurrent = BatchFetchService.BATCH_CONFIG.MAX_CONCURRENT_REQUESTS;
        const results = [];

        // Process LoRAs in parallel with concurrency limiting
        for (let i = 0; i < loraBatch.length; i += maxConcurrent) {
            // Check for cancellation before creating concurrent batch
            if (this.cancelFlag || checkCancelled()) {
                throw new Error('Operation cancelled');
            }

            const concurrentBatch = loraBatch.slice(i, i + Math.min(maxConcurrent, loraBatch.length - i));
            const concurrentPromises = concurrentBatch.map((loraName, batchIndex) => {
                const globalIndex = startIndex + i + batchIndex;

                // Add small staggered delay to avoid hitting rate limits simultaneously
                const delay = batchIndex * BatchFetchService.BATCH_CONFIG.ADAPTIVE_DELAY_BASE;
                return this.createCancellableDelay(delay, checkCancelled)
                    .then(() => this.processSingleLora(loraName, globalIndex, total, checkCancelled, updateProgress, updateText));
            });

            // Wait for all concurrent operations to complete
            const batchResults = await Promise.allSettled(concurrentPromises);

            // Process results and check for cancellation
            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    if (result.reason.message === 'Operation cancelled') {
                        throw new Error('Operation cancelled');
                    }
                    console.error('Batch processing error:', result.reason);
                    results.push({
                        success: false,
                        error: result.reason.message,
                        hasPreview: false,
                        loraName: 'unknown',
                        index: startIndex + i
                    });
                }
            }

            // Check for cancellation between concurrent batches
            if (this.cancelFlag || checkCancelled()) {
                throw new Error('Operation cancelled');
            }

            // Small delay between concurrent batches
            if (i + maxConcurrent < loraBatch.length) {
                await this.createCancellableDelay(
                    BatchFetchService.BATCH_CONFIG.ADAPTIVE_DELAY_BASE * 2,
                    checkCancelled
                );
            }
        }

        return results;
    }

    /**
     * Filter LoRAs based on preview availability status (async version to check placeholder previews)
     * @param {Array} loras - Array of LoRA objects or names
     * @param {Function} hasPreviewCallback - Original callback to check for preview images
     * @param {string} filterType - 'missing', 'existing', or 'all'
     * @returns {Promise<Object>} Filtered result with loras, skipped, and stats
     */
    async filterLorasByPreviewStatus(loras, hasPreviewCallback, filterType) {
        // Extract LoRA names and categorize them based on preview availability
        const allLoraNames = loras
            .filter(lora => lora !== "None")
            .map(lora => typeof lora === 'string' ? lora : lora.name || lora.file || String(lora))
            .filter(name => name && name !== "None");

        const missing = [];
        const existing = [];
        const withPlaceholderPreviews = [];

        // Check each LoRA for preview status (including placeholder previews)
        for (const loraName of allLoraNames) {
            const hasPreview = hasPreviewCallback(loraName);
            const hasPlaceholder = await this.hasPlaceholderPreview(loraName);

            if (hasPreview) {
                existing.push(loraName);
            } else if (hasPlaceholder) {
                withPlaceholderPreviews.push(loraName);
            } else {
                missing.push(loraName);
            }
        }

        const processedTotal = existing.length + withPlaceholderPreviews.length;


        switch (filterType) {
            case 'missing':
                return {
                    loras: missing,
                    skipped: [...existing, ...withPlaceholderPreviews],
                    stats: {
                        total: allLoraNames.length,
                        fetching: missing.length,
                        skipped: processedTotal,
                        type: 'Missing Previews',
                        withPlaceholderPreviews: withPlaceholderPreviews.length
                    }
                };
            case 'existing':
                return {
                    loras: existing,
                    skipped: [...missing, ...withPlaceholderPreviews],
                    stats: {
                        total: allLoraNames.length,
                        fetching: existing.length,
                        skipped: missing.length + withPlaceholderPreviews.length,
                        type: 'Existing Previews',
                        withPlaceholderPreviews: withPlaceholderPreviews.length
                    }
                };
            case 'all':
            default:
                return {
                    loras: allLoraNames,
                    skipped: [],
                    stats: {
                        total: allLoraNames.length,
                        fetching: allLoraNames.length,
                        skipped: 0,
                        type: 'All LoRAs',
                        withPlaceholderPreviews: withPlaceholderPreviews.length
                    }
                };
        }
    }

    /**
     * Fetch LoRA info from Civitai API with retry logic and better timeout handling
     * @param {string} loraName - Name of the LoRA to fetch
     * @param {Function} checkCancelled - Function to check if operation was cancelled
     * @returns {Promise<Object>} LoRA info data
     */
    async fetchLoraInfoWithRetry(loraName, checkCancelled) {
        const maxRetries = BatchFetchService.BATCH_CONFIG.MAX_RETRIES;
        const baseTimeout = BatchFetchService.BATCH_CONFIG.CIVITAI_TIMEOUT;
        const baseDelay = BatchFetchService.BATCH_CONFIG.RETRY_DELAY;
        const backoffMultiplier = BatchFetchService.BATCH_CONFIG.RETRY_BACKOFF_MULTIPLIER;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {

                // Check for cancellation before starting API call
                if (this.cancelFlag || checkCancelled()) {
                    throw new Error('Operation cancelled');
                }

                // Adaptive timeout - increase for later attempts
                const adaptiveTimeout = baseTimeout * Math.pow(backoffMultiplier, attempt - 1);

                // Use cancellable promise wrapper with adaptive timeout
                const apiPromise = vidApi.refreshSingleLoraInfo(loraName);
                const result = await this.createCancellablePromise(
                    apiPromise,
                    adaptiveTimeout,
                    checkCancelled
                );

                // Check for cancellation after API call completes
                if (this.cancelFlag || checkCancelled()) {
                    throw new Error('Operation cancelled');
                }


                // Check if we got image data
                if (result && result.length > 0) {
                    const loraInfo = result[0];
                    if (loraInfo.images && loraInfo.images.length > 0) {
                    } else {
                        console.warn(`[${loraName}] No images found in fetched data for preview generation`);
                    }
                    return loraInfo;
                } else {
                    console.warn(`[${loraName}] No data returned from API`);
                    return null;
                }

            } catch (error) {
                const isLastAttempt = attempt === maxRetries + 1;
                const isCancelled = error.message === 'Operation cancelled' || error.message === 'Operation timeout';

                if (isCancelled) {
                    throw new Error('Operation cancelled');
                }

                if (isLastAttempt) {
                    console.error(`[${loraName}] All fetch attempts failed after ${maxRetries + 1} attempts:`, error);
                    throw error;
                }

                // Calculate retry delay with exponential backoff
                const retryDelay = baseDelay * Math.pow(backoffMultiplier, attempt - 1);
                console.warn(`[${loraName}] Fetch attempt ${attempt} failed, retrying in ${retryDelay}ms:`, error.message);

                // Wait before retry (with cancellation support)
                try {
                    await this.createCancellableDelay(retryDelay, checkCancelled);
                } catch (delayError) {
                    if (delayError.message === 'Operation cancelled') {
                        throw new Error('Operation cancelled');
                    }
                }
            }
        }
    }

    /**
     * Generate preview images using the exact working pattern from dialog_info.js with retry logic
     * @param {Object} loraInfo - LoRA info object containing images
     * @param {Function} checkCancelled - Function to check if operation was cancelled
     * @returns {Promise<Object>} Preview generation result
     */
    async generatePreviewsWithRetry(loraInfo, checkCancelled) {
        if (!loraInfo || !loraInfo.file) {
            throw new Error('Invalid LoRA info for preview generation');
        }

        // Use the exact working pattern from dialog_info.js lines 475-480
        const loraName = loraInfo.file.replace(/\.[^/.]+$/, ""); // Remove extension
        const loraPath = loraInfo.file.includes('/') ? loraInfo.file.substring(0, loraInfo.file.lastIndexOf('/')) : '';

        const maxRetries = BatchFetchService.BATCH_CONFIG.MAX_RETRIES;
        const baseTimeout = BatchFetchService.BATCH_CONFIG.PREVIEW_GENERATION_TIMEOUT;
        const baseDelay = BatchFetchService.BATCH_CONFIG.RETRY_DELAY;
        const backoffMultiplier = BatchFetchService.BATCH_CONFIG.RETRY_BACKOFF_MULTIPLIER;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {

                // Check for cancellation before starting preview generation
                if (this.cancelFlag || checkCancelled()) {
                    throw new Error('Operation cancelled');
                }

                // Adaptive timeout for preview generation (videos can be slow)
                const adaptiveTimeout = baseTimeout * Math.pow(backoffMultiplier, attempt - 1);

                // Generate preview images using cancellable promise wrapper
                const previewPromise = generatePreviewFromFirstImage(loraInfo, loraName, loraPath);
                const previewResult = await this.createCancellablePromise(
                    previewPromise,
                    adaptiveTimeout,
                    checkCancelled
                );

                // Check for cancellation after preview generation
                if (this.cancelFlag || checkCancelled()) {
                    throw new Error('Operation cancelled');
                }

                return previewResult;

            } catch (error) {
                const isLastAttempt = attempt === maxRetries + 1;
                const isCancelled = error.message === 'Operation cancelled' || error.message === 'Operation timeout';

                if (isCancelled) {
                    throw new Error('Operation cancelled');
                }

                if (isLastAttempt) {
                    console.error(`[${loraName}] All preview generation attempts failed after ${maxRetries + 1} attempts:`, error);
                    throw error;
                }

                // Calculate retry delay with exponential backoff
                const retryDelay = baseDelay * Math.pow(backoffMultiplier, attempt - 1);
                console.warn(`[${loraName}] Preview generation attempt ${attempt} failed, retrying in ${retryDelay}ms:`, error.message);

                // Wait before retry (with cancellation support)
                try {
                    await this.createCancellableDelay(retryDelay, checkCancelled);
                } catch (delayError) {
                    if (delayError.message === 'Operation cancelled') {
                        throw new Error('Operation cancelled');
                    }
                }
            }
        }
    }

    /**
     * Main batch fetch operation with progress tracking and cancellation support
     * @param {Array} loras - Array of LoRA objects or names
     * @param {string} filterType - 'missing', 'existing', or 'all'
     * @param {Function} hasPreviewCallback - Function to check if LoRA has previews
     * @param {Object} progressCallbacks - Progress UI callbacks
     * @returns {Promise<Object>} Batch operation results
     */
    async fetchAllLoras(loras, filterType, hasPreviewCallback, progressCallbacks) {
        const {
            updateProgress,
            updateText,
            showError,
            showCompletion,
            checkCancelled
        } = progressCallbacks;

        // Reset cancel flag and create new abort controller at start of operation
        this.cancelFlag = false;
        this.abortController = new AbortController();

        // Filter LoRAs based on preview status
        const filteredData = await this.filterLorasByPreviewStatus(loras, hasPreviewCallback, filterType);
        const { loras: lorasToFetch, skipped, stats } = filteredData;

        const config = BatchFetchService.getConfig();


        if (lorasToFetch.length === 0) {
            return { success: true, message: 'No LoRAs to process', stats };
        }

        try {

            let completedCount = 0;
            let previewGeneratedCount = 0;
            let infoFetchFailures = 0;
            let previewGenerationFailures = 0;
            let videosSkippedCount = 0;
            let placeholderPreviewsCreated = 0;
            const totalLoras = lorasToFetch.length;
            const batchSize = BatchFetchService.BATCH_CONFIG.BATCH_SIZE;

            // Process LoRAs in batches with parallel execution within each batch
            for (let i = 0; i < lorasToFetch.length; i += batchSize) {
                // Check for cancellation before processing each batch
                if (this.cancelFlag || checkCancelled()) {
                    updateText(`Operation cancelled. Processed ${completedCount}/${totalLoras} LoRAs`);
                    break;
                }

                const batch = lorasToFetch.slice(i, i + Math.min(batchSize, totalLoras - i));

                try {
                    // Process the entire batch in parallel
                    const batchResults = await this.processBatchParallel(
                        batch,
                        i,
                        totalLoras,
                        checkCancelled,
                        updateProgress,
                        updateText
                    );

                    // Process results from parallel execution
                    let batchInfoFetched = 0;
                    let batchNoImages = 0;
                    let batchPreviewsGenerated = 0;
                    let batchFailures = 0;
                    let batchVideosSkipped = 0;
                    const placeholderPreviewQueue = []; // Queue for creating placeholder previews

                    for (const result of batchResults) {
                        if (result.success) {
                            completedCount++;
                            batchInfoFetched++;
                            if (result.hasPreview) {
                                previewGeneratedCount++;
                                batchPreviewsGenerated++;
                            } else {
                                batchNoImages++;
                                if (result.skippedVideos > 0) {
                                    batchVideosSkipped += result.skippedVideos;
                                } else {
                                }

                                // Queue for placeholder preview creation (even if cancelled)
                                if (result.needsPlaceholderPreview) {
                                    placeholderPreviewQueue.push(result.loraName);
                                }
                            }
                        } else {
                            infoFetchFailures++;
                            batchFailures++;
                        }
                    }

                    // Create placeholder previews for LoRAs that need them (even if operation was cancelled)
                    if (placeholderPreviewQueue.length > 0) {
                        for (const loraName of placeholderPreviewQueue) {
                            try {
                                await this.createPlaceholderPreview(loraName);
                            } catch (placeholderError) {
                                console.warn(`⚠ Failed to create placeholder preview for ${loraName}:`, placeholderError);
                            }
                        }
                    }


                    // Accumulate counts
                    videosSkippedCount += batchVideosSkipped;
                    placeholderPreviewsCreated += placeholderPreviewQueue.length;

                } catch (error) {
                    if (error.message === 'Operation cancelled') {
                        break;
                    }
                    console.error(`Batch ${Math.floor(i/batchSize) + 1} failed:`, error);
                    infoFetchFailures += batch.length;
                }

                // Check for cancellation between batches
                if (this.cancelFlag || checkCancelled()) {
                    break;
                }

                // Short delay between batches for API safety (cancellable)
                if (i + batchSize < lorasToFetch.length) {
                    try {
                        await this.createCancellableDelay(
                            BatchFetchService.BATCH_CONFIG.INTER_BATCH_DELAY,
                            checkCancelled
                        );
                    } catch (delayError) {
                        if (delayError.message === 'Operation cancelled') {
                            break;
                        }
                    }
                }
            }

            // Final progress update
            if (!this.cancelFlag && !checkCancelled()) {
                updateProgress(100);
            }

            // Calculate how many LoRAs had no images available
            const noImagesCount = completedCount - previewGeneratedCount;

            let completionMessage;
            if (this.cancelFlag || checkCancelled()) {
                completionMessage = `Operation cancelled. Processed ${completedCount}/${totalLoras} LoRAs`;
            } else {
                completionMessage = `Completed! Processed ${completedCount}/${totalLoras} LoRAs`;
            }

            if (stats.skipped > 0) {
                completionMessage += ` (${stats.skipped} already had previews)`;
            }
            if (previewGeneratedCount > 0) {
                completionMessage += `, generated ${previewGeneratedCount} new previews`;
            }
            if (noImagesCount > 0) {
                completionMessage += `, ${noImagesCount} had no preview images available`;
            }
            if (videosSkippedCount > 0) {
                completionMessage += `, skipped ${videosSkippedCount} video preview(s) to prevent timeouts`;
            }
            if (placeholderPreviewsCreated > 0) {
                completionMessage += `, created ${placeholderPreviewsCreated} placeholder previews`;
            }
            if (infoFetchFailures > 0 || previewGenerationFailures > 0) {
                completionMessage += ` (${infoFetchFailures} fetch failures, ${previewGenerationFailures} preview failures)`;
            }

            updateText(completionMessage);

            return {
                success: !this.cancelFlag,
                message: completionMessage,
                stats: {
                    ...stats,
                    completed: completedCount,
                    previewsGenerated: previewGeneratedCount,
                    noImagesAvailable: noImagesCount,
                    videosSkipped: videosSkippedCount,
                    placeholderPreviewsCreated: placeholderPreviewsCreated,
                    infoFetchFailures,
                    previewGenerationFailures,
                    cancelled: this.cancelFlag
                }
            };

        } catch (error) {
            if (error.message === 'Operation cancelled') {
                updateText('Operation cancelled successfully');
                return {
                    success: false,
                    cancelled: true,
                    message: 'Operation cancelled',
                    stats: {
                        ...stats,
                        completed: completedCount,
                        previewsGenerated: previewGeneratedCount,
                        cancelled: true
                    }
                };
            }

            console.error('Error during batch fetch:', error);
            showError(`Error: ${error.message}`);

            return {
                success: false,
                error: error.message,
                stats
            };
        }
    }

    /**
     * Cancel the current batch operation aggressively
     */
    cancel() {
        this.cancelFlag = true;

        // Abort any ongoing requests
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Update batch configuration parameters
     * @param {Object} newConfig - New configuration values to merge
     */
    static updateConfig(newConfig) {
        BatchFetchService.BATCH_CONFIG = {
            ...BatchFetchService.BATCH_CONFIG,
            ...newConfig
        };
    }

    /**
     * Get current configuration
     * @returns {Object} Current batch configuration
     */
    static getConfig() {
        return { ...BatchFetchService.BATCH_CONFIG };
    }

    
    /**
     * Gather comprehensive statistics about all LoRAs in the system
     * @param {Function} hasPreviewCallback - Function to check if LoRA has previews
     * @param {Array} allLoras - Array of all available LoRA names
     * @returns {Promise<Object>} Comprehensive statistics object
     */
    async gatherComprehensiveStats(hasPreviewCallback, allLoras) {

        const stats = {
            totalLoRAs: 0,
            withPreviews: 0,
            withPlaceholders: 0,
            withoutPreviews: 0,
            videoOnlyLoRAs: 0,
            stats: {
                missing: 0,
                existing: 0,
                withPlaceholderPreviews: 0
            },
            fileTypes: {},
            processingStatus: {
                processed: 0,
                unprocessed: 0,
                needsReview: 0
            },
            recentActivity: {
                fetchedToday: 0,
                fetchedThisWeek: 0,
                placeholderCreated: 0
            }
        };

        try {
            // Get comprehensive filtering stats
            const allStats = await this.filterLorasByPreviewStatus(allLoras, hasPreviewCallback, 'all');
            const missingStats = await this.filterLorasByPreviewStatus(allLoras, hasPreviewCallback, 'missing');
            const existingStats = await this.filterLorasByPreviewStatus(allLoras, hasPreviewCallback, 'existing');

            stats.totalLoRAs = allStats.stats.total;
            stats.withPreviews = existingStats.stats.fetching;
            stats.withPlaceholders = existingStats.stats.withPlaceholderPreviews || 0;
            stats.withoutPreviews = missingStats.stats.fetching;
            stats.stats = {
                missing: missingStats.stats.fetching,
                existing: existingStats.stats.fetching,
                withPlaceholderPreviews: existingStats.stats.withPlaceholderPreviews || 0
            };

            // Calculate processing status
            stats.processingStatus.processed = stats.withPreviews + stats.withPlaceholders;
            stats.processingStatus.unprocessed = stats.withoutPreviews;
            stats.processingStatus.needsReview = stats.withPlaceholders;

            // Analyze file types
            for (const loraName of allLoras) {
                const extension = loraName.split('.').pop().toLowerCase();
                stats.fileTypes[extension] = (stats.fileTypes[extension] || 0) + 1;
            }

            return stats;

        } catch (error) {
            console.error('❌ Error gathering LoRA statistics:', error);
            return {
                error: error.message,
                totalLoRAs: allLoras ? allLoras.length : 0
            };
        }
    }

    /**
     * Create a beautiful stats display dialog
     * @param {Object} stats - Statistics object
     * @returns {void}
     */
    createStatsDialog(stats) {
        // Remove any existing stats dialog
        const existingDialog = document.getElementById('lora-stats-dialog');
        if (existingDialog) {
            existingDialog.remove();
        }

        // Create dialog container
        const dialog = document.createElement('div');
        dialog.id = 'lora-stats-dialog';
        dialog.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%) !important;
            border: 2px solid #444 !important;
            border-radius: 12px !important;
            box-shadow: 0 10px 40px rgba(0,0,0,0.8) !important;
            padding: 24px !important;
            z-index: 10000 !important;
            min-width: 600px !important;
            max-width: 800px !important;
            font-family: 'Segoe UI', Arial, sans-serif !important;
            color: #fff !important;
        `;

        // Create dialog content
        dialog.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #444; padding-bottom: 12px;">
                <h2 style="margin: 0; color: #4CAF50; font-size: 24px; font-weight: 600;">📊 LoRA Statistics</h2>
                <button onclick="this.closest('#lora-stats-dialog').remove()" style="
                    background: #f44336 !important;
                    border: none !important;
                    color: white !important;
                    padding: 8px 16px !important;
                    border-radius: 6px !important;
                    cursor: pointer !important;
                    font-size: 14px !important;
                    font-weight: 600 !important;
                ">✕ Close</button>
            </div>

            ${stats.error ? `
                <div style="background: #f44336; color: white; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
                    <strong>❌ Error:</strong> ${stats.error}
                </div>
            ` : ''}

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px;">
                <div style="background: linear-gradient(135deg, #4CAF50, #45a049); padding: 16px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 4px;">${stats.totalLoRAs || 0}</div>
                    <div style="font-size: 14px; opacity: 0.9;">Total LoRAs</div>
                </div>
                <div style="background: linear-gradient(135deg, #2196F3, #1976D2); padding: 16px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 4px;">${stats.withPreviews || 0}</div>
                    <div style="font-size: 14px; opacity: 0.9;">With Previews</div>
                </div>
                <div style="background: linear-gradient(135deg, #FF9800, #F57C00); padding: 16px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 4px;">${stats.withPlaceholders || 0}</div>
                    <div style="font-size: 14px; opacity: 0.9;">Placeholders</div>
                </div>
                <div style="background: linear-gradient(135deg, #9C27B0, #7B1FA2); padding: 16px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 28px; font-weight: bold; margin-bottom: 4px;">${stats.withoutPreviews || 0}</div>
                    <div style="font-size: 14px; opacity: 0.9;">Need Processing</div>
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 16px;">
                <div>
                    <h3 style="color: #4CAF50; margin-bottom: 12px; font-size: 16px;">📈 Processing Status</h3>
                    <div style="background: #333; padding: 12px; border-radius: 6px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span>✅ Processed:</span>
                            <strong style="color: #4CAF50;">${stats.processingStatus?.processed || 0}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span>⏳ Unprocessed:</span>
                            <strong style="color: #FF9800;">${stats.processingStatus?.unprocessed || 0}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>🔍 Needs Review:</span>
                            <strong style="color: #9C27B0;">${stats.processingStatus?.needsReview || 0}</strong>
                        </div>
                    </div>
                </div>

                <div>
                    <h3 style="color: #2196F3; margin-bottom: 12px; font-size: 16px;">📁 File Types</h3>
                    <div style="background: #333; padding: 12px; border-radius: 6px; max-height: 100px; overflow-y: auto;">
                        ${Object.entries(stats.fileTypes || {}).map(([ext, count]) => `
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span>.${ext.toUpperCase()}</span>
                                <strong>${count}</strong>
                            </div>
                        `).join('') || '<div style="color: #888; text-align: center;">No data available</div>'}
                    </div>
                </div>
            </div>

            <div style="background: #333; padding: 12px; border-radius: 6px; font-size: 12px; color: #ccc; text-align: center;">
                📅 Last updated: ${new Date().toLocaleString()}
            </div>
        `;

        document.body.appendChild(dialog);
    }

    /**
     * Reset the cancel flag for new operations
     */
    resetCancelFlag() {
        this.cancelFlag = false;
        this.abortController = null;
    }
}

// Export singleton instance for easy use
export const batchFetchService = new BatchFetchService();