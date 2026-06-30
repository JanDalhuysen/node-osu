#include <iostream>
#include <map>
#include <string>
#include <vector>

#include <aubio/aubio.h>

struct NoteEvent
{
    double start_time;
    double duration;
    int pitch;
    double strength;
};

struct ActiveNote
{
    double start_time;
    double strength;
};

class NoteDetector
{
  private:
    uint_t sample_rate;
    uint_t hop_size;
    uint_t win_size;

  public:
    NoteDetector(uint_t sr = 44100, uint_t hop = 512, uint_t win = 1024) : sample_rate(sr), hop_size(hop), win_size(win)
    {
    }

    std::vector<NoteEvent> detectNotes(const std::string &filename)
    {
        std::vector<NoteEvent> notes_list;

        // Create source
        aubio_source_t *source = new_aubio_source(filename.c_str(), sample_rate, hop_size);
        if (!source)
        {
            std::cerr << "Error: could not open " << filename << std::endl;
            return notes_list;
        }

        // Create notes detection object
        aubio_notes_t *notes = new_aubio_notes("default", win_size, hop_size, sample_rate);
        if (!notes)
        {
            std::cerr << "Error: could not initialize note detector" << std::endl;
            del_aubio_source(source);
            return notes_list;
        }

        // Optional: set silence threshold (can be adjusted)
        aubio_notes_set_silence(notes, -50.0);

        // Allocate memory
        fvec_t *in = new_fvec(hop_size);
        fvec_t *out = new_fvec(3); // [0] = MIDI note on, [1] = velocity, [2] = MIDI note off

        uint_t read = 0;
        uint_t total_frames = 0;

        // Map to keep track of active notes: pitch -> start time and detected velocity
        std::map<int, ActiveNote> active_notes;

        do
        {
            // Read audio file
            aubio_source_do(source, in, &read);

            // Execute note detection
            aubio_notes_do(notes, in, out);

            double current_time = (double)total_frames / sample_rate;

            // 1. Check note-off events
            int note_off = (int)out->data[2];
            if (note_off > 0)
            {
                auto it = active_notes.find(note_off);
                if (it != active_notes.end())
                {
                    double start_time = it->second.start_time;
                    double duration = current_time - start_time;
                    if (duration > 0.05) // filter out ultra-short transient noise/glitches
                    {
                        NoteEvent ev;
                        ev.start_time = start_time;
                        ev.duration = duration;
                        ev.pitch = note_off;
                        ev.strength = it->second.strength;
                        notes_list.push_back(ev);
                    }
                    active_notes.erase(it);
                }
            }

            // 2. Check note-on events
            int note_on = (int)out->data[0];
            if (note_on > 0)
            {
                double note_strength = out->data[1] > 0.0 ? out->data[1] / 127.0 : 1.0;
                // If the note was already active, close it first
                auto it = active_notes.find(note_on);
                if (it != active_notes.end())
                {
                    double start_time = it->second.start_time;
                    double duration = current_time - start_time;
                    if (duration > 0.05)
                    {
                        NoteEvent ev;
                        ev.start_time = start_time;
                        ev.duration = duration;
                        ev.pitch = note_on;
                        ev.strength = note_strength;
                        notes_list.push_back(ev);
                    }
                }
                active_notes[note_on] = {current_time, note_strength};
            }

            total_frames += read;
        } while (read == hop_size);

        // Close any remaining active notes
        double total_duration = (double)total_frames / sample_rate;
        for (auto const &[pitch, active_note] : active_notes)
        {
            double start_time = active_note.start_time;
            double duration = total_duration - start_time;
            if (duration > 0.05)
            {
                NoteEvent ev;
                ev.start_time = start_time;
                ev.duration = duration;
                ev.pitch = pitch;
                ev.strength = active_note.strength;
                notes_list.push_back(ev);
            }
        }

        // Clean up
        del_aubio_notes(notes);
        del_aubio_source(source);
        del_fvec(in);
        del_fvec(out);

        return notes_list;
    }
};

int main(int argc, char **argv)
{
    if (argc != 2)
    {
        std::cerr << "Usage: " << argv[0] << " <audiofile>" << std::endl;
        return 1;
    }

    NoteDetector detector;
    std::vector<NoteEvent> notes = detector.detectNotes(argv[1]);

    // Print notes details: start_time duration pitch strength
    for (const auto &note : notes)
    {
        std::cout << note.start_time << " " << note.duration << " " << note.pitch << " " << note.strength << std::endl;
    }

    aubio_cleanup();

    return 0;
}
