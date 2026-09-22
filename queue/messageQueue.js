/**
 * =====================================================
 * DVARY BOT - MULTI SESSION MESSAGE QUEUE
 * =====================================================
 *
 * Features:
 * - Separate queue for every WhatsApp session
 * - Separate queue for every chat
 * - Prevents messages from mixing between sessions
 * - Priority support
 * - Group batching
 * - Global concurrency limit
 * - Backward compatible with old enqueue()
 * =====================================================
 */

class MessageQueue {
	constructor() {
		/*
		|--------------------------------------------------------------------------
		| Session queues
		|--------------------------------------------------------------------------
		|
		| queues:
		|
		| Map<
		|   sessionId,
		|   Map<
		|     chatId,
		|     Message[]
		|   >
		| >
		|
		*/

		this.queues = new Map();

		/*
		|--------------------------------------------------------------------------
		| Processing state
		|--------------------------------------------------------------------------
		*/

		this.processing = new Map();

		/*
		|--------------------------------------------------------------------------
		| Configuration
		|--------------------------------------------------------------------------
		*/

		this.messageDelay = 50;

		this.groupMessageDelay = 100;

		this.maxConcurrent = 10;

		this.activeSends = 0;

		this.batchSize = 5;

		this.groupBatchDelay = 200;

		/*
		|--------------------------------------------------------------------------
		| Multi-session mode
		|--------------------------------------------------------------------------
		*/

		this.multiSession = true;

		/*
		|--------------------------------------------------------------------------
		| Queue cleanup
		|--------------------------------------------------------------------------
		*/

		this.cleanupInterval = setInterval(
			() => {
				this.cleanupEmptyQueues();
			},
			300000
		);

		/*
		|--------------------------------------------------------------------------
		| Don't keep Node process alive only for cleanup
		|--------------------------------------------------------------------------
		*/

		if (
			this.cleanupInterval &&
			typeof this.cleanupInterval.unref ===
				"function"
		) {
			this.cleanupInterval.unref();
		}
	}

	/*
	|--------------------------------------------------------------------------
	| Normalize session ID
	|--------------------------------------------------------------------------
	*/

	normalizeSessionId(sessionId) {
		if (
			typeof sessionId !== "string" ||
			!sessionId.trim()
		) {
			return "default";
		}

		return sessionId.trim();
	}

	/*
	|--------------------------------------------------------------------------
	| Normalize chat ID
	|--------------------------------------------------------------------------
	*/

	normalizeChatId(chatId) {
		if (
			typeof chatId !== "string" ||
			!chatId.trim()
		) {
			throw new Error(
				"chatId is required"
			);
		}

		return chatId.trim();
	}

	/*
	|--------------------------------------------------------------------------
	| Get session queue
	|--------------------------------------------------------------------------
	*/

	getSessionQueue(
		sessionId,
		create = true
	) {
		sessionId =
			this.normalizeSessionId(
				sessionId
			);

		let sessionQueue =
			this.queues.get(
				sessionId
			);

		if (
			!sessionQueue &&
			create
		) {
			sessionQueue =
				new Map();

			this.queues.set(
				sessionId,
				sessionQueue
			);
		}

		return sessionQueue || null;
	}

	/*
	|--------------------------------------------------------------------------
	| Get session processing map
	|--------------------------------------------------------------------------
	*/

	getSessionProcessing(
		sessionId,
		create = true
	) {
		sessionId =
			this.normalizeSessionId(
				sessionId
			);

		let processing =
			this.processing.get(
				sessionId
			);

		if (
			!processing &&
			create
		) {
			processing =
				new Map();

			this.processing.set(
				sessionId,
				processing
			);
		}

		return processing || null;
	}

	/*
	|--------------------------------------------------------------------------
	| Check processing
	|--------------------------------------------------------------------------
	*/

	isProcessing(
		sessionId,
		chatId
	) {
		const processing =
			this.getSessionProcessing(
				sessionId,
				false
			);

		return (
			processing?.get(
				chatId
			) === true
		);
	}

	/*
	|--------------------------------------------------------------------------
	| ENQUEUE
	|--------------------------------------------------------------------------
	|
	| Supports BOTH:
	|
	| New:
	|
	| enqueue(
	|   sessionId,
	|   chatId,
	|   sendFunction,
	|   priority
	| )
	|
	| Old:
	|
	| enqueue(
	|   chatId,
	|   sendFunction,
	|   priority
	| )
	|
	*/

	async enqueue(...args) {
		let sessionId;
		let chatId;
		let sendFunction;
		let priority;

		/*
		|--------------------------------------------------------------------------
		| New multi-session format
		|--------------------------------------------------------------------------
		*/

		if (
			args.length >= 3 &&
			typeof args[1] === "string" &&
			typeof args[2] === "function"
		) {
			sessionId =
				this.normalizeSessionId(
					args[0]
				);

			chatId =
				this.normalizeChatId(
					args[1]
				);

			sendFunction =
				args[2];

			priority =
				Number.isFinite(
					args[3]
				)
					? args[3]
					: 0;
		}

		/*
		|--------------------------------------------------------------------------
		| Old format
		|--------------------------------------------------------------------------
		*/

		else {
			sessionId = "default";

			chatId =
				this.normalizeChatId(
					args[0]
				);

			sendFunction =
				args[1];

			priority =
				Number.isFinite(
					args[2]
				)
					? args[2]
					: 0;
		}

		/*
		|--------------------------------------------------------------------------
		| Validate send function
		|--------------------------------------------------------------------------
		*/

		if (
			typeof sendFunction !==
			"function"
		) {
			throw new TypeError(
				"sendFunction must be a function"
			);
		}

		/*
		|--------------------------------------------------------------------------
		| Get session queue
		|--------------------------------------------------------------------------
		*/

		const sessionQueue =
			this.getSessionQueue(
				sessionId,
				true
			);

		/*
		|--------------------------------------------------------------------------
		| Get chat queue
		|--------------------------------------------------------------------------
		*/

		if (
			!sessionQueue.has(
				chatId
			)
		) {
			sessionQueue.set(
				chatId,
				[]
			);
		}

		const queue =
			sessionQueue.get(
				chatId
			);

		/*
		|--------------------------------------------------------------------------
		| Add message
		|--------------------------------------------------------------------------
		*/

		const message = {
			sendFunction,

			priority,

			createdAt:
				Date.now(),

			sessionId,

			chatId,
		};

		queue.push(
			message
		);

		/*
		|--------------------------------------------------------------------------
		| Priority sorting
		|--------------------------------------------------------------------------
		*/

		queue.sort(
			(a, b) =>
				b.priority -
					a.priority ||
				a.createdAt -
					b.createdAt
		);

		/*
		|--------------------------------------------------------------------------
		| Start processing
		|--------------------------------------------------------------------------
		*/

		if (
			!this.isProcessing(
				sessionId,
				chatId
			)
		) {
			void this.processQueue(
				sessionId,
				chatId
			);
		}

		return true;
	}

	/*
	|--------------------------------------------------------------------------
	| Process queue
	|--------------------------------------------------------------------------
	*/

	async processQueue(
		sessionId,
		chatId
	) {
		sessionId =
			this.normalizeSessionId(
				sessionId
			);

		chatId =
			this.normalizeChatId(
				chatId
			);

		const sessionQueue =
			this.getSessionQueue(
				sessionId,
				false
			);

		if (!sessionQueue) {
			return;
		}

		const queue =
			sessionQueue.get(
				chatId
			);

		if (
			!queue ||
			queue.length === 0
		) {
			sessionQueue.delete(
				chatId
			);

			if (
				sessionQueue.size === 0
			) {
				this.queues.delete(
					sessionId
				);
			}

			return;
		}

		const processing =
			this.getSessionProcessing(
				sessionId,
				true
			);

		/*
		|--------------------------------------------------------------------------
		| Already processing
		|--------------------------------------------------------------------------
		*/

		if (
			processing.get(
				chatId
			)
		) {
			return;
		}

		processing.set(
			chatId,
			true
		);

		try {
			while (
				queue.length > 0
			) {
				/*
				|--------------------------------------------------------------------------
				| Wait for global concurrency slot
				|--------------------------------------------------------------------------
				*/

				while (
					this.activeSends >=
					this.maxConcurrent
				) {
					await this.sleep(
						25
					);
				}

				/*
				|--------------------------------------------------------------------------
				| Group batching
				|--------------------------------------------------------------------------
				*/

				const isGroup =
					chatId.endsWith(
						"@g.us"
					);

				if (
					isGroup
				) {
					await this.processGroupBatch(
						sessionId,
						chatId,
						queue
					);
				} else {
					await this.processSingleMessage(
						queue
					);
				}

				/*
				|--------------------------------------------------------------------------
				| Delay
				|--------------------------------------------------------------------------
				*/

				if (
					queue.length > 0
				) {
					await this.sleep(
						isGroup
							? this.groupMessageDelay
							: this.messageDelay
					);
				}
			}
		} catch (error) {
			console.error(
				`❌ Queue processing error [${sessionId}] [${chatId}]:`,
				error?.message ||
					error
			);
		} finally {
			processing.delete(
				chatId
			);

			/*
			|--------------------------------------------------------------------------
			| Cleanup chat
			|--------------------------------------------------------------------------
			*/

			if (
				queue.length === 0
			) {
				sessionQueue.delete(
					chatId
				);
			}

			/*
			|--------------------------------------------------------------------------
			| Cleanup session
			|--------------------------------------------------------------------------
			*/

			if (
				sessionQueue.size === 0
			) {
				this.queues.delete(
					sessionId
				);
			}

			if (
				processing.size === 0
			) {
				this.processing.delete(
					sessionId
				);
			}
		}
	}

	/*
	|--------------------------------------------------------------------------
	| Process single message
	|--------------------------------------------------------------------------
	*/

	async processSingleMessage(
		queue
	) {
		const item =
			queue.shift();

		if (!item) {
			return;
		}

		this.activeSends++;

		try {
			await item.sendFunction();
		} catch (error) {
			console.error(
				`❌ Send error [${item.sessionId}] [${item.chatId}]:`,
				error?.message ||
					error
			);
		} finally {
			this.activeSends--;
		}
	}

	/*
	|--------------------------------------------------------------------------
	| Process group batch
	|--------------------------------------------------------------------------
	*/

	async processGroupBatch(
		sessionId,
		chatId,
		queue
	) {
		const batch =
			queue.splice(
				0,
				Math.min(
					this.batchSize,
					queue.length
				)
			);

		if (
			batch.length === 0
		) {
			return;
		}

		/*
		|--------------------------------------------------------------------------
		| Available concurrency
		|--------------------------------------------------------------------------
		*/

		const available =
			Math.max(
				1,
				this.maxConcurrent -
					this.activeSends
			);

		const sendBatch =
			batch.slice(
				0,
				available
			);

		/*
		|--------------------------------------------------------------------------
		| Put remaining messages back
		|--------------------------------------------------------------------------
		*/

		if (
			sendBatch.length <
			batch.length
		) {
			queue.unshift(
				...batch.slice(
					sendBatch.length
				)
			);
		}

		this.activeSends +=
			sendBatch.length;

		try {
			await Promise.all(
				sendBatch.map(
					async (item) => {
						try {
							await item.sendFunction();
						} catch (error) {
							console.error(
								`❌ Group send error [${sessionId}] [${chatId}]:`,
								error?.message ||
									error
							);
						} finally {
							this.activeSends--;
						}
					}
				)
			);
		} catch (error) {
			console.error(
				`❌ Group batch error [${sessionId}] [${chatId}]:`,
				error?.message ||
					error
			);
		}

		/*
		|--------------------------------------------------------------------------
		| Small batch delay
		|--------------------------------------------------------------------------
		*/

		if (
			queue.length > 0
		) {
			await this.sleep(
				this.groupBatchDelay
			);
		}
	}

	/*
	|--------------------------------------------------------------------------
	| Sleep
	|--------------------------------------------------------------------------
	*/

	sleep(ms) {
		return new Promise(
			(resolve) =>
				setTimeout(
					resolve,
					ms
				)
		);
	}

	/*
	|--------------------------------------------------------------------------
	| Cleanup empty queues
	|--------------------------------------------------------------------------
	*/

	cleanupEmptyQueues() {
		for (
			const [
				sessionId,
				sessionQueue,
			] of this.queues.entries()
		) {
			for (
				const [
					chatId,
					queue,
				] of sessionQueue.entries()
			) {
				if (
					!queue ||
					queue.length === 0
				) {
					sessionQueue.delete(
						chatId
					);
				}
			}

			if (
				sessionQueue.size === 0
			) {
				this.queues.delete(
					sessionId
				);
			}
		}

		for (
			const [
				sessionId,
				processing,
			] of this.processing.entries()
		) {
			if (
				processing.size === 0
			) {
				this.processing.delete(
					sessionId
				);
			}
		}
	}

	/*
	|--------------------------------------------------------------------------
	| Get stats
	|--------------------------------------------------------------------------
	*/

	getStats(sessionId = null) {
		/*
		|--------------------------------------------------------------------------
		| Specific session
		|--------------------------------------------------------------------------
		*/

		if (
			sessionId !== null
		) {
			sessionId =
				this.normalizeSessionId(
					sessionId
				);

			const sessionQueue =
				this.getSessionQueue(
					sessionId,
					false
				);

			const processing =
				this.getSessionProcessing(
					sessionId,
					false
				);

			let queued = 0;

			if (
				sessionQueue
			) {
				for (
					const queue of
						sessionQueue.values()
				) {
					queued +=
						queue.length;
				}
			}

			return {
				sessionId,

				queued,

				chats:
					sessionQueue
						?.size || 0,

				processing:
					processing
						?.size || 0,

				activeSends:
					this.activeSends,

				maxConcurrent:
					this.maxConcurrent,
			};
		}

		/*
		|--------------------------------------------------------------------------
		| All sessions
		|--------------------------------------------------------------------------
		*/

		const sessions = {};

		let totalQueued = 0;

		for (
			const sessionId of
				this.queues.keys()
		) {
			const stats =
				this.getStats(
					sessionId
				);

			sessions[
				sessionId
			] = stats;

			totalQueued +=
				stats.queued;
		}

		return {
			totalQueued,

			activeSends:
				this.activeSends,

			maxConcurrent:
				this.maxConcurrent,

			sessionCount:
				this.queues.size,

			sessions,
		};
	}

	/*
	|--------------------------------------------------------------------------
	| Clear queue
	|--------------------------------------------------------------------------
	|
	| clearQueue(sessionId)
	| clearQueue(sessionId, chatId)
	|
	*/

	clearQueue(
		sessionId = "default",
		chatId = null
	) {
		sessionId =
			this.normalizeSessionId(
				sessionId
			);

		const sessionQueue =
			this.getSessionQueue(
				sessionId,
				false
			);

		if (!sessionQueue) {
			return 0;
		}

		/*
		|--------------------------------------------------------------------------
		| Clear specific chat
		|--------------------------------------------------------------------------
		*/

		if (
			chatId !== null
		) {
			chatId =
				this.normalizeChatId(
					chatId
				);

			const queue =
				sessionQueue.get(
					chatId
				);

			const count =
				queue?.length || 0;

			sessionQueue.delete(
				chatId
			);

			return count;
		}

		/*
		|--------------------------------------------------------------------------
		| Clear whole session
		|--------------------------------------------------------------------------
		*/

		let count = 0;

		for (
			const queue of
				sessionQueue.values()
		) {
			count +=
				queue.length;
		}

		sessionQueue.clear();

		this.queues.delete(
			sessionId
		);

		return count;
	}

	/*
	|--------------------------------------------------------------------------
	| Clear session
	|--------------------------------------------------------------------------
	*/

	clearSession(
		sessionId = "default"
	) {
		return this.clearQueue(
			sessionId
		);
	}

	/*
	|--------------------------------------------------------------------------
	| Clear everything
	|--------------------------------------------------------------------------
	*/

	clearAll() {
		let count = 0;

		for (
			const sessionQueue of
				this.queues.values()
		) {
			for (
				const queue of
					sessionQueue.values()
			) {
				count +=
					queue.length;
			}
		}

		this.queues.clear();

		return count;
	}

	/*
	|--------------------------------------------------------------------------
	| Get session IDs
	|--------------------------------------------------------------------------
	*/

	getSessionIds() {
		return [
			...this.queues.keys(),
		];
	}

	/*
	|--------------------------------------------------------------------------
	| Get queued count
	|--------------------------------------------------------------------------
	*/

	getQueuedCount(
		sessionId = null
	) {
		if (
			sessionId !== null
		) {
			return this.getStats(
				sessionId
			).queued;
		}

		let total = 0;

		for (
			const sessionQueue of
				this.queues.values()
		) {
			for (
				const queue of
					sessionQueue.values()
			) {
				total +=
					queue.length;
			}
		}

		return total;
	}

	/*
	|--------------------------------------------------------------------------
	| Get active sends
	|--------------------------------------------------------------------------
	*/

	getActiveSends() {
		return this.activeSends;
	}

	/*
	|--------------------------------------------------------------------------
	| Get queue snapshot
	|--------------------------------------------------------------------------
	*/

	getSnapshot() {
		const result = {};

		for (
			const [
				sessionId,
				sessionQueue,
			] of this.queues.entries()
		) {
			result[
				sessionId
			] = {};

			for (
				const [
					chatId,
					queue,
				] of sessionQueue.entries()
			) {
				result[
					sessionId
				][chatId] = {
					length:
						queue.length,

					processing:
						this.isProcessing(
							sessionId,
							chatId
						),
				};
			}
		}

		return result;
	}

	/*
	|--------------------------------------------------------------------------
	| Destroy queue manager
	|--------------------------------------------------------------------------
	*/

	destroy() {
		if (
			this.cleanupInterval
		) {
			clearInterval(
				this.cleanupInterval
			);

			this.cleanupInterval =
				null;
		}

		this.clearAll();

		this.processing.clear();

		this.activeSends = 0;
	}
}

/*
|--------------------------------------------------------------------------
| Create queue instance
|--------------------------------------------------------------------------
*/

const messageQueue =
	new MessageQueue();

/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

export default messageQueue;
