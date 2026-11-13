#pragma once
// Minimal checks for the sim tests: they stay active in Release builds (unlike assert).
#include <cmath>
#include <cstdio>
#include <cstdlib>

// Timing budgets are only asserted in optimized builds (CI also runs Debug).
#ifdef NDEBUG
inline constexpr bool kSimOptimized = true;
#else
inline constexpr bool kSimOptimized = false;
#endif

inline int& SimFailures() { static int n = 0; return n; }

#define SIM_CHECK(cond, ...)                                                       \
  do {                                                                             \
    if (!(cond)) {                                                                 \
      std::printf("FAIL %s:%d: %s: ", __FILE__, __LINE__, #cond);                  \
      std::printf(__VA_ARGS__);                                                    \
      std::printf("\n");                                                           \
      ++SimFailures();                                                             \
    }                                                                              \
  } while (0)
#define SIM_NEAR(a, b, tol, what)                                                  \
  SIM_CHECK(std::abs((a) - (b)) <= (tol), "%s: %.6g vs %.6g (tol %.3g)", what, static_cast<double>(a), \
            static_cast<double>(b), static_cast<double>(tol))

inline int SimResult(const char* name) {
  if (SimFailures()) { std::printf("%s: %d check(s) failed\n", name, SimFailures()); return 1; }
  std::printf("%s: all checks passed\n", name);
  return 0;
}
