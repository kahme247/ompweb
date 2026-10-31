package io.github.kahme247.ompweb.net

import java.io.IOException
import kotlinx.coroutines.CancellationException

/**
 * Runs one API call and reports every failure as an [ApiError]: nothing but
 * cancellation may escape a view-model coroutine (an uncaught IOException
 * would crash the app instead of showing a notice).
 */
suspend fun <T> captureApi(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: ApiError) {
    Result.failure(error)
} catch (error: IOException) {
    Result.failure(ApiError.Network(error))
} catch (error: Exception) {
    Result.failure(ApiError.Network(IOException(error)))
}
