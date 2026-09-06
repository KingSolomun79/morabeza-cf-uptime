import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { AppRoutes } from "./AppRoutes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Operator data changes with every cron tick; stale-while-revalidate is
      // plenty. Failed queries retry once (API errors are usually decisive).
      staleTime: 15_000,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
