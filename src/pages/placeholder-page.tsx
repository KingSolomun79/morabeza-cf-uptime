/**
 * Placeholder page (issue #21): one component reused by all eight nav
 * sections until the real pages land in #22–#27 (PRD §27.2).
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          This section arrives with the Phase&nbsp;7 page slices — the shell, navigation, and data plumbing
          are already in place.
        </p>
      </CardContent>
    </Card>
  );
}
