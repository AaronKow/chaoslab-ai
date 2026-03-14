import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const SERVER_BASE_URL = "http://localhost:8787";

type Command = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [commands, setCommands] = useState<Command[]>([]);
  const [serverUrl, setServerUrl] = useState(SERVER_BASE_URL);
  const [loading, setLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canStartSession = useMemo(
    () => !loading && !sessionId && serverUrl.startsWith("http"),
    [loading, sessionId, serverUrl],
  );

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
      }
    };
  }, []);

  const startSession = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${serverUrl}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "ios-sim" }),
      });
      const data = await response.json();
      setSessionId(data.sessionId);
      setCursor(0);
      setCommands([]);
      schedulePoll(data.sessionId, 0, 200);
    } finally {
      setLoading(false);
    }
  };

  const schedulePoll = (nextSessionId: string, since: number, delayMs: number) => {
    pollingRef.current = setTimeout(() => pollCommands(nextSessionId, since), delayMs);
  };

  const pollCommands = async (activeSessionId: string, since: number) => {
    try {
      const response = await fetch(
        `${serverUrl}/commands?sessionId=${activeSessionId}&since=${since}&timeout=5000`,
      );
      const data = await response.json();

      if (Array.isArray(data.commands) && data.commands.length > 0) {
        setCommands((current) => [...data.commands, ...current].slice(0, 30));
        setCursor(data.nextSince);
        for (const command of data.commands) {
          await fetch(`${serverUrl}/ack`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-session-id": activeSessionId,
            },
            body: JSON.stringify({ commandId: command.id, status: "ok" }),
          });
        }
        schedulePoll(activeSessionId, data.nextSince, 350);
      } else {
        setCursor(data.nextSince ?? since);
        schedulePoll(activeSessionId, data.nextSince ?? since, 800);
      }
    } catch {
      schedulePoll(activeSessionId, since, 1500);
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>ChaosLab AR Pilot (HTTP)</Text>
      <Text style={styles.subtitle}>Session + command polling scaffold for iOS AR app</Text>

      <TextInput
        value={serverUrl}
        onChangeText={setServerUrl}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder="https://your-orchestrator.example.com"
        placeholderTextColor="#8d8f98"
      />

      <Pressable disabled={!canStartSession} onPress={startSession} style={styles.button}>
        {loading ? <ActivityIndicator color="#05070b" /> : <Text style={styles.buttonText}>Start Session</Text>}
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.label}>Session ID</Text>
        <Text style={styles.value}>{sessionId ?? "Not started"}</Text>
        <Text style={styles.label}>Cursor</Text>
        <Text style={styles.value}>{cursor}</Text>
      </View>

      <Text style={styles.sectionTitle}>Latest Commands</Text>
      <FlatList
        data={commands}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.commandRow}>
            <Text style={styles.commandTitle}>#{item.id} {item.type}</Text>
            <Text style={styles.commandPayload}>{JSON.stringify(item.payload)}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No commands yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#05070b",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    color: "#eff2ff",
    fontSize: 22,
    fontWeight: "700",
  },
  subtitle: {
    color: "#98a2b3",
    marginTop: 4,
    marginBottom: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: "#252a35",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e4e6ee",
    marginBottom: 10,
  },
  button: {
    backgroundColor: "#9fe870",
    borderRadius: 10,
    height: 46,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
  },
  buttonText: {
    color: "#05070b",
    fontWeight: "700",
  },
  card: {
    backgroundColor: "#0f1219",
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  label: {
    color: "#98a2b3",
    fontSize: 12,
    marginTop: 2,
  },
  value: {
    color: "#e4e6ee",
    fontSize: 13,
  },
  sectionTitle: {
    color: "#eff2ff",
    fontWeight: "600",
    marginBottom: 8,
  },
  commandRow: {
    backgroundColor: "#0f1219",
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  commandTitle: {
    color: "#9fe870",
    fontWeight: "600",
  },
  commandPayload: {
    color: "#c0c5d3",
    fontSize: 12,
    marginTop: 4,
  },
  empty: {
    color: "#98a2b3",
    textAlign: "center",
    marginTop: 16,
  },
});
