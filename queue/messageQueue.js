/**
 * ============================================================
 * DVARY BOT - MULTI SESSION MESSAGE QUEUE
 * ============================================================
 *
 * Kila WhatsApp session ina queue yake.
 *
 * Supported:
 *   enqueue(chatId, sendFunction, priority)
 *   enqueue(sessionId, chatId, sendFunction, priority)
 *
 * Multi-session format ndiyo inayopendekezwa:
 *   messageQueue.enqueue(sessionId, chatId, sendFunction, priority)
 *
 * ============================================================
 */

class MessageQueue {
	constructor() {
		/**
		 * Structure:
		 *
		 * queues = Map<
		 *   sessionId,
		 *   Map<
		 *     chatId,
		 *     Array<Message>
		 *   >
		 * >
		 */
		this.queues = new Map();

		/**
		 * Processing status
		 *
		 * Map<
		 *   sessionId,
		 *   Map<chatId, boolean>
		 * >
		 */
		this.processing = new Map();

		// Delay between normal messages
		this.messageDelay = 50;

		// Delay between group batches
		this.groupMessageDelay = 100;

		// Maximum sends across all sessions
		this.maxConcurrent = 10;

		// Currently active sends
		this.activeSends = 0;

		// Group batch size
		this.batchSize = 5;

		// Delay between group batches
		this.groupBatchDelay = 200;

		// Cleanup every 5 minutes
		this.cleanupInterval = setInterval(() => {
			this.cleanupEmptyQueues();
		}, 300000);

		// Prevent Node from keeping process alive because of this timer
		if (this.cleanupInterval.unref) {
			this.cleanupInterval.unref();
		}

		this.multiSession = true;
	}

	/**
	 * ============================================================
	 * INTERNAL HELPERS
	 * ============================================================
	 */

	normalizeSessionId(sessionId) {
		if (
			sessionId === undefined ||
			sessionId === null ||
			sessionId === ""
		) {
			return "default";
		}

		return String(sessionId);
	}

	/**
	 * Get/create session queue
	 */
	getSessionQueue(sessionId, create = true) {
		sessionId = this.normalizeSessionId(sessionId);

		if (!this.queues.has(sessionId)) {
			if (!create) return null;

			this.queues.set(sessionId, new Map());
		}

		return this.queues.get(sessionId);
	}

	/**
	 * Get/create session processing map
	 */
	getSessionProcessing(sessionId, create = true) {
		sessionId = this.normalizeSessionId(sessionId);

		if (!this.processing.has(sessionId)) {
			if (!create) return null;

			this.processing.set(sessionId, new Map());
		}

		return this.processing.get(sessionId);
	}

	/**
	 * Check whether chat is currently processing
	 */
	isProcessing(sessionId, chatId) {
		const processing = this.getSessionProcessing(sessionId, false);

		return processing?.get(chatId) === true;
	}

	/**
	 * ============================================================
	 * CLEANUP
	 * ============================================================
	 */

	cleanupEmptyQueues() {
		let cleaned = 0;

		for (const [sessionId, sessionQueues] of this.queues.entries()) {
			for (const [chatId, queue] of sessionQueues.entries()) {
				if (!queue || queue.length === 0) {
					sessionQueues.delete(chatId);
					cleaned++;
				}
			}

			if (sessionQueues.size === 0) {
				this.queues.delete(sessionId);
				cleaned++;
			}
		}

		for (const [sessionId, processingMap] of this.processing.entries()) {
			for (const [chatId, status] of processingMap.entries()) {
				if (
					!status &&
					!this.queues.get(sessionId)?.has(chatId)
				) {
					processingMap.delete(chatId);
					cleaned++;
				}
			}

			if (processingMap.size === 0) {
				this.processing.delete(sessionId);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			console.log(
				`🧹 MessageQueue cleanup: removed ${cleaned} empty entries`
			);
		}
	}

	/**
	 * ============================================================
	 * ENQUEUE
	 * ============================================================
	 *
	 * Supported:
	 *
	 * OLD:
	 * enqueue(chatId, sendFunction, priority)
	 *
	 * NEW:
	 * enqueue(sessionId, chatId, sendFunction, priority)
	 */

	async enqueue(...args) {
		let sessionId;
		let chatId;
		let sendFunction;
		let priority;

		/**
		 * Backward compatibility
		 *
		 * enqueue(chatId, sendFunction, priority)
		 */
		if (typeof args[1] === "function") {
			sessionId = "default";
			chatId = args[0];
			sendFunction = args[1];
			priority = args[2] ?? 1;
		}

		/**
		 * Multi-session
		 *
		 * enqueue(sessionId, chatId, sendFunction, priority)
		 */
		else {
			sessionId = args[0];
			chatId = args[1];
			sendFunction = args[2];
			priority = args[3] ?? 1;
		}

		sessionId = this.normalizeSessionId(sessionId);

		if (!chatId) {
			throw new Error("MessageQueue: chatId is required");
		}

		if (typeof sendFunction !== "function") {
			throw new Error(
				"MessageQueue: sendFunction must be a function"
			);
		}

		chatId = String(chatId);

		const sessionQueues = this.getSessionQueue(sessionId);
		const processing = this.getSessionProcessing(sessionId);

		if (!sessionQueues.has(chatId)) {
			sessionQueues.set(chatId, []);
		}

		const queue = sessionQueues.get(chatId);

		queue.push({
			sendFunction,
			priority: Number(priority) || 1,
			timestamp: Date.now(),
			sessionId,
			chatId,
		});

		/**
		 * Lower priority number = higher priority
		 *
		 * If same priority, older message first.
		 */
		queue.sort((a, b) => {
			if (a.priority !== b.priority) {
				return a.priority - b.priority;
			}

			return a.timestamp - b.timestamp;
		});

		/**
		 * Start processing if this chat is not already processing
		 */
		if (!processing.get(chatId)) {
			void this.processQueue(sessionId, chatId);
		}

		return true;
	}

	/**
	 * ============================================================
	 * PROCESS QUEUE
	 * ============================================================
	 */

	async processQueue(sessionId, chatId) {
		sessionId = this.normalizeSessionId(sessionId);

		const sessionQueues = this.getSessionQueue(sessionId, false);
		const processing = this.getSessionProcessing(sessionId);

		if (!sessionQueues) {
			return;
		}

		if (processing.get(chatId)) {
			return;
		}

		processing.set(chatId, true);

		try {
			const queue = sessionQueues.get(chatId);

			if (!queue) {
				return;
			}

			const isGroup = chatId.endsWith("@g.us");

			while (queue.length > 0) {
				const batchSize = isGroup
					? this.batchSize
					: 1;

				const batch = [];

				/**
				 * Collect messages
				 */
				for (
					let i = 0;
					i < batchSize && queue.length > 0;
					i++
				) {
					/**
					 * Wait until global concurrency is available
					 */
					while (
						this.activeSends >= this.maxConcurrent
					) {
						await this.sleep(50);
					}

					const message = queue.shift();

					if (!message) {
						continue;
					}

					batch.push(message);

					this.activeSends++;
				}

				/**
				 * Send batch
				 */
				const batchPromises = batch.map(
					async (message) => {
						try {
							await message.sendFunction();
						} catch (error) {
							console.error(
								`❌ Queue send error [${sessionId}] [${chatId}]:`,
								error?.message || error
							);
						} finally {
							this.activeSends--;

							/**
							 * Safety protection
							 */
							if (this.activeSends < 0) {
								this.activeSends = 0;
							}
						}
					}
				);

				await Promise.all(batchPromises);

				/**
				 * Delay before next batch
				 */
				if (queue.length > 0) {
					const delay = isGroup
						? this.groupBatchDelay
						: this.messageDelay;

					await this.sleep(delay);
				}
			}
		} catch (error) {
			console.error(
				`❌ Queue processor error [${sessionId}] [${chatId}]:`,
				error?.message || error
			);
		} finally {
			processing.set(chatId, false);

			/**
			 * Remove empty chat queue
			 */
			const queue = sessionQueues.get(chatId);

			if (!queue || queue.length === 0) {
				sessionQueues.delete(chatId);
			}

			/**
			 * Remove empty processing state
			 */
			if (processing.size === 0) {
				this.processing.delete(sessionId);
			}

			/**
			 * Remove empty session queue
			 */
			if (sessionQueues.size === 0) {
				this.queues.delete(sessionId);
			}
		}
	}

	/**
	 * ============================================================
	 * SLEEP
	 * ============================================================
	 */

	sleep(ms) {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	/**
	 * ============================================================
	 * GET STATS
	 * ============================================================
	 */

	getStats(sessionId = null) {
		/**
		 * Stats for one session
		 */
		if (sessionId !== null) {
			sessionId = this.normalizeSessionId(sessionId);

			const sessionQueues =
				this.getSessionQueue(sessionId, false);

			let totalQueued = 0;
			const queuesByChat = {};

			if (sessionQueues) {
				for (const [chatId, queue] of sessionQueues.entries()) {
					const length = queue?.length || 0;

					totalQueued += length;
					queuesByChat[chatId] = length;
				}
			}

			return {
				sessionId,
				totalQueued,
				queuesByChat,
				activeSends: this.activeSends,
			};
		}

		/**
		 * Stats for all sessions
		 */
		const stats = {
			totalQueued: 0,
			activeSends: this.activeSends,
			sessions: {},
		};

		for (const [
			currentSessionId,
			sessionQueues,
		] of this.queues.entries()) {
			let sessionTotal = 0;

			const queuesByChat = {};

			for (const [chatId, queue] of sessionQueues.entries()) {
				const length = queue?.length || 0;

				sessionTotal += length;
				queuesByChat[chatId] = length;
			}

			stats.totalQueued += sessionTotal;

			stats.sessions[currentSessionId] = {
				totalQueued: sessionTotal,
				queuesByChat,
			};
		}

		return stats;
	}

	/**
	 * ============================================================
	 * CLEAR ONE CHAT
	 * ============================================================
	 */

	clearQueue(sessionId, chatId = null) {
		/**
		 * Backward compatibility:
		 *
		 * clearQueue(chatId)
		 */
		if (chatId === null) {
			chatId = sessionId;
			sessionId = "default";
		}

		sessionId = this.normalizeSessionId(sessionId);

		const sessionQueues =
			this.getSessionQueue(sessionId, false);

		if (!sessionQueues) {
			return false;
		}

		if (!sessionQueues.has(chatId)) {
			return false;
		}

		sessionQueues.get(chatId).length = 0;
		sessionQueues.delete(chatId);

		return true;
	}

	/**
	 * ============================================================
	 * CLEAR SESSION
	 * ============================================================
	 */

	clearSession(sessionId = "default") {
		sessionId = this.normalizeSessionId(sessionId);

		const sessionQueues =
			this.getSessionQueue(sessionId, false);

		if (sessionQueues) {
			for (const queue of sessionQueues.values()) {
				queue.length = 0;
			}

			sessionQueues.clear();
		}

		this.queues.delete(sessionId);

		return true;
	}

	/**
	 * ============================================================
	 * CLEAR EVERYTHING
	 * ============================================================
	 */

	clearAll() {
		for (const sessionQueues of this.queues.values()) {
			for (const queue of sessionQueues.values()) {
				queue.length = 0;
			}

			sessionQueues.clear();
		}

		this.queues.clear();

		return true;
	}

	/**
	 * ============================================================
	 * GET SESSION IDS
	 * ============================================================
	 */

	getSessionIds() {
		return [...this.queues.keys()];
	}

	/**
	 * ============================================================
	 * GET QUEUED COUNT
	 * ============================================================
	 */

	getQueuedCount(sessionId = null) {
		if (sessionId !== null) {
			const stats = this.getStats(sessionId);
			return stats.totalQueued;
		}

		return this.getStats().totalQueued;
	}

	/**
	 * ============================================================
	 * GET ACTIVE SENDS
	 * ============================================================
	 */

	getActiveSends() {
		return this.activeSends;
	}

	/**
	 * ============================================================
	 * DESTROY
	 * ============================================================
	 */

	destroy() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		this.clearAll();
		this.processing.clear();

		console.log("🧹 MessageQueue destroyed");
	}
}

/**
 * ============================================================
 * SINGLETON
 * ============================================================
 */

const messageQueue = new MessageQueue();

export default messageQueue;
